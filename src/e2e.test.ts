import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import funzzyStatus from "./index.js";
import { type WatcherCorrelatedSnapshot } from "./domain/capabilities.js";
import capabilitiesFixture from "./domain/fixtures/capabilities.json" with { type: "json" };

/**
 * End-to-end proof of the agent feedback loop (contract §10): the real
 * composition root (index.ts) drives the real tools and lifecycle over a
 * scripted FakeWatcherServer listening on a real Unix socket, with a real git
 * worktree behind the fingerprint contract. Deterministic: every step is
 * control-driven — no sleeps, no arbitrary waits, no environment mutation
 * beyond a temp dir.
 */

interface FakeRun {
  runId: number;
  socket: Socket;
}

interface RunOptions {
  trigger?: string;
  commands?: string[];
  failures?: string[];
  durationMs?: number;
}

type CapabilityFeatures = {
  atomicAwait: boolean;
  subscription: boolean;
  correlatedSnapshots: boolean;
  outputRetrieval: boolean;
  pendingWork: boolean;
  durationEstimates: boolean;
  sequentialOverride: boolean;
};

let serverCounter = 0;

class FakeWatcherServer {
  readonly calls: string[] = [];
  private readonly server;
  private readonly sockets = new Set<Socket>();
  private token: string;
  private generation = 0;
  private state: "idle" | "running" | "passed" | "failed" | "cancelled" = "idle";
  private trigger: string | null = null;
  private commands: string[] = [];
  private durationMs: number | null = null;
  private failures: string[] = [];
  private targets: Array<{ name: string; commands: string[]; estimate?: Record<string, unknown> }> =
    [
      { name: "@agent-final", commands: ["make all"] },
      { name: "lint", commands: ["npm run lint"] },
      { name: "test", commands: ["npm test"] },
    ];
  private features: CapabilityFeatures = {
    atomicAwait: true,
    subscription: true,
    correlatedSnapshots: true,
    outputRetrieval: true,
    pendingWork: true,
    durationEstimates: true,
    sequentialOverride: true,
  };
  private legacyCapabilities = false;
  private subscribers = new Set<Socket>();
  private pendingRun: FakeRun | null = null;
  private nextRun: RunOptions = {};
  private outputByKey = new Map<string, Record<string, unknown>>();
  private malformedTarget: string | null = null;
  private hangTarget: string | null = null;
  private pushCount = 0;
  rawLines: string[] = [];
  private waiters = new Map<string, Array<() => void>>();
  private pushWaiters: Array<() => void> = [];

  constructor() {
    this.token = `fz-e2e-${++serverCounter}`;
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  get instanceToken(): string {
    return this.token;
  }

  static async start(): Promise<{
    server: FakeWatcherServer;
    socketPath: string;
    cleanup: () => Promise<void>;
  }> {
    const dir = await mkdtemp(join(tmpdir(), "pi-watcher-e2e-"));
    const socketPath = join(dir, "funzzy.sock");
    const server = new FakeWatcherServer();
    await new Promise<void>((resolve, reject) => {
      server.server.once("error", reject);
      server.server.listen(socketPath, resolve);
    });
    return {
      server,
      socketPath,
      cleanup: async () => {
        for (const socket of server.sockets) socket.destroy();
        await new Promise<void>((resolve) => server.server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  /** Restart with a fresh instance identity; generation numbering restarts. */
  restart(): void {
    this.token = `fz-e2e-${++serverCounter}`;
    this.generation = 0;
    this.state = "idle";
    this.trigger = null;
    this.commands = [];
    this.durationMs = null;
    this.failures = [];
    this.pendingRun = null;
    for (const socket of this.subscribers) socket.end();
    this.subscribers.clear();
  }

  downgradeToLegacy(): void {
    this.legacyCapabilities = true;
  }

  setFeatures(features: Partial<CapabilityFeatures>): void {
    this.features = { ...this.features, ...features };
  }

  setTargets(
    targets: Array<{ name: string; commands: string[]; estimate?: Record<string, unknown> }>,
  ): void {
    this.targets = targets;
  }

  setStatus(status: {
    generation: number;
    state: "idle" | "running" | "passed" | "failed" | "cancelled";
    trigger: string | null;
    commands?: string[];
    durationMs?: number | null;
    failures?: string[];
  }): void {
    this.generation = status.generation;
    this.state = status.state;
    this.trigger = status.trigger;
    this.commands = status.commands ?? [];
    this.durationMs = status.durationMs ?? null;
    this.failures = status.failures ?? [];
  }

  setNextRun(options: RunOptions): void {
    this.nextRun = options;
  }

  scriptOutput(
    generation: number,
    task: string | null,
    options: Partial<Record<string, unknown>> = {},
  ): void {
    const stream = {
      content: "",
      lines: 0,
      retainedBytes: 0,
      observedBytes: 0,
      truncated: false,
      ...options,
    };
    this.outputByKey.set(`${generation}:${task ?? ""}`, {
      generation,
      tasks: task === null ? [] : [{ id: task, stdout: stream, stderr: null }],
    });
  }

  malformedNext(method: string): void {
    this.malformedTarget = method;
  }

  hangNext(method: string): void {
    this.hangTarget = method;
  }

  /** Test-driven run start (observe flow): bump generation, push running. */
  startRun(options: RunOptions = {}): number {
    this.nextRun = options;
    return this.startRunInternal(null, false);
  }

  /** Finalize the current run: push the terminal snapshot (+ runComplete). */
  completeRun(options: {
    outcome: "passed" | "failed" | "cancelled";
    failures?: string[];
    durationMs?: number;
  }): number {
    const run = this.pendingRun;
    this.state = options.outcome;
    this.failures = options.failures ?? this.nextRun.failures ?? [];
    this.durationMs = options.durationMs ?? this.nextRun.durationMs ?? 42;
    this.nextRun = {};
    const snapshot = this.currentSnapshot();
    this.pushSnapshot(snapshot);
    if (run !== null) {
      this.send(run.socket, {
        jsonrpc: "2.0",
        method: "runComplete",
        params: { runId: run.runId, snapshot },
      });
      this.pendingRun = null;
      run.socket.end();
    }
    return this.generation;
  }

  closeSubscriptions(): void {
    for (const socket of this.subscribers) socket.end();
    this.subscribers.clear();
  }

  /** Wait until `method` has been called `count` times (event-driven, bounded). */
  waitForCallCount(method: string, count: number, timeoutMs = 5_000): Promise<void> {
    const seen = this.calls.filter((call) => call === method).length;
    if (seen >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.set(
          method,
          (this.waiters.get(method) ?? []).filter((entry) => entry !== onCall),
        );
        reject(new Error(`Timed out waiting for ${count}x ${method} (saw ${seen})`));
      }, timeoutMs);
      const onCall = (): void => {
        if (this.calls.filter((call) => call === method).length >= count) {
          clearTimeout(timer);
          this.waiters.set(
            method,
            (this.waiters.get(method) ?? []).filter((entry) => entry !== onCall),
          );
          resolve();
        }
      };
      this.waiters.set(method, [...(this.waiters.get(method) ?? []), onCall]);
    });
  }

  waitForCall(method: string, timeoutMs = 5_000): Promise<void> {
    return this.waitForCallCount(method, 1, timeoutMs);
  }

  /** Wait until a snapshot push has been broadcast `count` times. */
  waitForPushCount(count: number, timeoutMs = 5_000): Promise<void> {
    if (this.pushCount >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${count} snapshot pushes`)),
        timeoutMs,
      );
      const onPush = (): void => {
        if (this.pushCount >= count) {
          clearTimeout(timer);
          this.pushWaiters = this.pushWaiters.filter((entry) => entry !== onPush);
          resolve();
        }
      };
      this.pushWaiters.push(onPush);
    });
  }

  // ── protocol handlers ────────────────────────────────────────────────────

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    this.rawLines.push("CONNECT");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void this.handleRequest(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.subscribers.delete(socket);
      if (this.pendingRun?.socket === socket) this.pendingRun = null;
    });
  }

  private handleRequest(socket: Socket, line: string): void {
    let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.respond(socket, undefined, { code: -32700, message: "parse error" });
      return;
    }
    const method = message.method ?? "";
    this.calls.push(method);

    if (this.hangTarget === method) {
      this.hangTarget = null;
      return;
    }
    if (this.malformedTarget === method) {
      this.malformedTarget = null;
      socket.write("garbage-not-json\n");
      return;
    }

    switch (method) {
      case "status":
        this.respond(socket, {
          generation: this.generation,
          state: this.state,
          trigger: this.trigger,
          commands: this.commands,
          durationMs: this.durationMs,
          failures: this.failures,
          services: [],
        });
        break;
      case "targets":
        this.respond(socket, this.targets);
        break;
      case "capabilities":
        if (this.legacyCapabilities) {
          this.respond(socket, undefined, { code: -32601, message: "Method not found" });
        } else {
          this.respond(socket, {
            ...capabilitiesFixture,
            instance: { token: this.token, startedAtEpochMs: 0 },
            features: this.features,
          });
        }
        break;
      case "subscribe": {
        this.subscribers.add(socket);
        this.send(socket, { jsonrpc: "2.0", id: "subscribe", result: this.currentSnapshot() });
        break;
      }
      case "run": {
        this.startRunInternal(socket, message.params?.wait === true);
        if (message.params?.wait !== true) socket.end();
        break;
      }
      case "cancel": {
        const generation = message.params?.generation;
        const cancelled = generation === this.generation && this.state === "running";
        this.respond(socket, { cancelled, generation: this.generation });
        break;
      }
      case "output": {
        const generation = message.params?.generation;
        const task: unknown = message.params?.task ?? null;
        const scripted = this.outputByKey.get(
          `${generation}:${typeof task === "string" ? task : ""}`,
        );
        if (scripted !== undefined) {
          this.respond(socket, scripted);
        } else {
          this.respond(socket, undefined, {
            code: -32000,
            message: `no retained output for generation ${generation}`,
          });
        }
        break;
      }
      default:
        this.respond(socket, undefined, { code: -32601, message: "Method not found" });
    }
    // Resolve waiters only after the request was fully handled, so the test
    // never races ahead of server state (e.g. pendingRun registration).
    for (const onCall of this.waiters.get(method) ?? []) onCall();
    this.waiters.set(method, []);
  }

  private startRunInternal(runSocket: Socket | null, hold: boolean): number {
    const options = this.nextRun;
    this.generation += 1;
    const runId = this.generation;
    this.state = "running";
    this.trigger = options.trigger ?? "src/main.ts";
    this.commands = options.commands ?? [];
    this.durationMs = null;
    this.failures = [];
    this.nextRun = {};
    this.pushSnapshot(this.currentSnapshot());
    if (runSocket !== null) {
      this.respond(runSocket, { runId });
      if (hold) this.pendingRun = { runId, socket: runSocket };
    }
    return runId;
  }

  private currentSnapshot(): WatcherCorrelatedSnapshot {
    return {
      instance: { token: this.token, startedAtEpochMs: 0 },
      batchId: `b-${this.generation}`,
      generation: this.generation,
      state: this.state,
      trigger: this.trigger,
      commands: this.commands,
      tasks: [],
      services: [],
      pending: 0,
      durationMs: this.durationMs,
      failures: this.failures,
      freshness: "current",
      paths: this.trigger === null ? [] : [this.trigger],
      configuredConcurrency: 2,
      effectiveConcurrency: 2,
      concurrencySource: "config",
    };
  }

  private pushSnapshot(snapshot: WatcherCorrelatedSnapshot): void {
    this.pushCount += 1;
    for (const onPush of this.pushWaiters.splice(0)) onPush();
    for (const socket of this.subscribers) {
      this.send(socket, { jsonrpc: "2.0", method: "snapshot", params: snapshot });
    }
  }

  private respond(
    socket: Socket,
    result: unknown,
    error?: { code: number; message: string },
  ): void {
    this.send(
      socket,
      error === undefined
        ? { jsonrpc: "2.0", id: "req", result }
        : { jsonrpc: "2.0", id: "req", error },
    );
  }

  private send(socket: Socket, payload: unknown): void {
    socket.write(`${JSON.stringify(payload)}\n`);
  }
}

// ── harness ────────────────────────────────────────────────────────────────

type RegisteredTool = {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

type RegisteredShortcut = {
  handler: (ctx: unknown) => Promise<void> | void;
};

function createPi() {
  const tools: RegisteredTool[] = [];
  const commands: unknown[] = [];
  const shortcuts = new Map<string, RegisteredShortcut>();
  const activeTools = new Set<string>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sendMessage = vi.fn();
  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    }),
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.push(tool);
      activeTools.add(tool.name);
    }),
    registerCommand: vi.fn((command: unknown) => commands.push(command)),
    registerShortcut: vi.fn((shortcut: string, options: RegisteredShortcut) => {
      shortcuts.set(shortcut, options);
    }),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.clear();
      for (const name of names) activeTools.add(name);
    },
    exec: vi.fn(
      async (command: string, args: string[], options: { cwd: string; timeout: number }) => {
        try {
          const result = await execFile(command, args, {
            cwd: options.cwd,
            timeout: options.timeout,
            env: gitEnv(),
          });
          return { stdout: result.stdout, stderr: result.stderr, code: 0 };
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string; code?: number };
          return {
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
            code: failure.code ?? 1,
          };
        }
      },
    ),
    sendMessage,
  };
  return { pi, tools, commands, shortcuts, handlers, sendMessage };
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

async function runTool(
  tool: RegisteredTool | undefined,
  params: Record<string, unknown>,
  ctx: unknown,
  onUpdate?: (update: { content: Array<{ type: string; text: string }> }) => void,
): Promise<ToolResult> {
  return (await tool!.execute("1", params, undefined, onUpdate, ctx)) as ToolResult;
}

async function runToolSignal(
  tool: RegisteredTool | undefined,
  params: Record<string, unknown>,
  ctx: unknown,
  signal: AbortSignal,
): Promise<ToolResult> {
  return (await tool!.execute("1", params, signal, undefined, ctx)) as ToolResult;
}

async function createWorktree(socketPath: string): Promise<{
  dir: string;
  edit: (path: string, content: string) => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pi-watcher-worktree-"));
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "e2e@example.com"]);
  git(["config", "user.name", "e2e"]);
  await writeFile(join(dir, ".watch.yaml"), `on:\n  socket: ${socketPath}\n`);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/main.ts"), "export const version = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "baseline"]);
  return {
    dir,
    edit: (path, content) => writeFile(join(dir, path), content),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function createCtx(cwd: string, sessionId = "session-1") {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus: vi.fn(), notify: vi.fn(), theme: { fg: () => "" } },
  };
}

async function createHarness() {
  const { server, socketPath, cleanup: cleanupServer } = await FakeWatcherServer.start();
  const worktree = await createWorktree(socketPath);
  const { pi, tools, commands, shortcuts, handlers, sendMessage } = createPi();
  funzzyStatus(pi as never);
  const ctx = createCtx(worktree.dir);
  const tool = (name: string): RegisteredTool => {
    const entry = tools.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`Tool ${name} not registered`);
    return entry;
  };
  const sessionStart = async (): Promise<void> => {
    await handlers.get("session_start")!(undefined, ctx);
  };
  const waitForNextSubscribe = async (): Promise<void> => {
    const seen = server.calls.filter((call) => call === "subscribe").length;
    await server.waitForCallCount("subscribe", seen + 1);
  };
  const toolCall = (event: Record<string, unknown>): Promise<unknown> =>
    handlers.get("tool_call")!(event, ctx) as Promise<unknown>;
  const toolResult = (event: Record<string, unknown>): Promise<unknown> =>
    handlers.get("tool_result")!(event, ctx) as Promise<unknown>;
  const shortcut = (name: string): RegisteredShortcut => {
    const entry = shortcuts.get(name);
    if (entry === undefined) throw new Error(`Shortcut ${name} not registered`);
    return entry;
  };
  return {
    server,
    socketPath,
    worktree,
    pi,
    tools,
    commands,
    shortcuts,
    handlers,
    sendMessage,
    shortcut,
    ctx,
    tool,
    sessionStart,
    waitForNextSubscribe,
    toolCall,
    toolResult,
    cleanup: async (): Promise<void> => {
      await cleanupServer();
      await worktree.cleanup();
    },
  };
}

const execFile = promisify(execFileCallback);

/** Git environment without host-repo redirection (hooks export GIT_DIR). */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

/** Drain microtasks + I/O callbacks without fixed sleeps. */
async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("agent watcher feedback loop (end to end)", () => {
  it("keyboard shortcut triggers the default final gate through the real control socket", async () => {
    const h = await createHarness();
    try {
      h.server.setStatus({
        generation: 5,
        state: "passed",
        trigger: "src/main.ts",
        commands: ["make all"],
        durationMs: 42,
      });
      await h.sessionStart();
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"] });

      await h.shortcut("ctrl+shift+alt+f").handler(h.ctx);

      expect(h.server.calls).toContain("run");
      expect(h.ctx.ui.notify).toHaveBeenCalledWith(
        "Funzzy final gate started: @agent-final generation 6",
        "info",
      );
      h.server.completeRun({ outcome: "passed", durationMs: 12 });
    } finally {
      await h.cleanup();
    }
  });

  it("fresh observation progress distinguishes excluded baseline from selected generation", async () => {
    const h = await createHarness();
    try {
      h.server.setStatus({
        generation: 5,
        state: "failed",
        trigger: "src/main.ts",
        commands: ["make all"],
        durationMs: 42,
        failures: ["baseline failed"],
      });
      await h.sessionStart();

      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"] });
      const updates: Array<{ content: Array<{ type: string; text: string }> }> = [];
      const freshPromise = runTool(
        h.tool("watcher_observe"),
        { wait: true, afterGeneration: 5 },
        h.ctx,
        (update) => updates.push(update),
      );
      await h.waitForNextSubscribe();
      h.server.startRun();
      h.server.completeRun({ outcome: "passed", durationMs: 12 });
      const fresh = await freshPromise;

      expect(updates[0]!.content[0]!.text).toMatch(
        /^WAITING gen>5 current=5 state=failed excluded=true freshness=current waited=\d+s$/,
      );
      expect(
        updates.some((update) => update.content[0]!.text.startsWith("PASS gen=6 selectedAfter=5")),
      ).toBe(true);
      expect(fresh.content[0]!.text).toBe(
        "PASS gen=6 freshness=current duration=12ms concurrency=2/2 source=config",
      );
    } finally {
      await h.cleanup();
    }
  });

  it("green loop: observe baseline, edit, await exact fresh generation, accept unchanged-fingerprint verification", async () => {
    const h = await createHarness();
    try {
      h.server.setStatus({
        generation: 5,
        state: "passed",
        trigger: "src/main.ts",
        commands: ["make all"],
        durationMs: 42,
      });
      await h.sessionStart();

      // 1. baseline observation
      const baseline = await runTool(h.tool("watcher_observe"), { wait: false }, h.ctx);
      expect(baseline.details).toMatchObject({
        outcome: "snapshot",
        generation: 5,
        state: "passed",
        correlation: "unknown",
      });

      // 2. edit (tool_call activity + successful edit result checkpoint)
      await h.worktree.edit("src/main.ts", "export const version = 2;\n");
      await h.toolCall({
        type: "tool_call",
        toolCallId: "t1",
        toolName: "edit",
        params: { path: "src/main.ts" },
      });
      await h.toolResult({
        type: "tool_result",
        toolCallId: "t1",
        toolName: "edit",
        input: { path: "src/main.ts" },
        content: [],
        isError: false,
      });

      // 3. watcher runs the fresh generation; await it via observe
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"] });
      const freshPromise = runTool(
        h.tool("watcher_observe"),
        { wait: true, afterGeneration: 5 },
        h.ctx,
      );
      await h.waitForNextSubscribe();
      h.server.startRun();
      h.server.completeRun({ outcome: "passed", durationMs: 12 });
      const fresh = await freshPromise;
      expect(fresh.details).toMatchObject({
        outcome: "terminal",
        generation: 6,
        state: "passed",
        correlation: "exact-overlap",
      });

      // 4. verification accepts with the unchanged worktree fingerprint
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"] });
      const verifyPromise = runTool(h.tool("watcher_verify"), { target: "lint" }, h.ctx);
      await h.server.waitForCall("run");
      h.server.completeRun({ outcome: "passed", durationMs: 12 });
      const verification = await verifyPromise;
      const details = verification.details as {
        reason: string;
        generation: number;
        fingerprint: string;
        fingerprintBefore: string;
      };
      expect(details).toMatchObject({ reason: "passed", generation: 7 });
      expect(details.fingerprint).toBe(details.fingerprintBefore);

      // exactly the loop calls — no cancellation, no output retrieval
      expect(h.server.calls).not.toContain("cancel");
      expect(h.server.calls).not.toContain("output");
      expect(h.server.calls.filter((call) => call === "run")).toHaveLength(1);

      // compact outputs stay well under a 2 KiB budget
      expect(Buffer.byteLength(baseline.content[0]!.text)).toBeLessThan(2_048);
      expect(Buffer.byteLength(verification.content[0]!.text)).toBeLessThan(2_048);
    } finally {
      await h.cleanup();
    }
  });

  it("chooses a negotiated target estimate, while an explicit timeout still wins", async () => {
    const h = await createHarness();
    try {
      await h.sessionStart();
      h.server.setTargets([
        {
          name: "lint",
          commands: ["npm run lint"],
          estimate: {
            typicalMs: 38_000,
            upperMs: 61_000,
            recommendedTimeoutMs: 95_000,
            samples: 12,
            confidence: "high",
            source: "measured",
          },
        },
      ]);

      const firstRunCount = h.server.calls.filter((call) => call === "run").length;
      const measured = runTool(h.tool("watcher_verify"), { target: "lint" }, h.ctx);
      await h.server.waitForCallCount("run", firstRunCount + 1);
      h.server.completeRun({ outcome: "passed", durationMs: 12 });
      expect((await measured).details).toMatchObject({
        timeout: { milliseconds: 95_000, source: "measured" },
      });

      const explicitRunCount = h.server.calls.filter((call) => call === "run").length;
      const explicit = runTool(
        h.tool("watcher_verify"),
        { target: "lint", timeoutSeconds: 30 },
        h.ctx,
      );
      await h.server.waitForCallCount("run", explicitRunCount + 1);
      h.server.completeRun({ outcome: "passed", durationMs: 12 });
      expect((await explicit).details).toMatchObject({
        timeout: { milliseconds: 30_000, source: "explicit" },
      });
    } finally {
      await h.cleanup();
    }
  });

  it("failure loop: bounded evidence, exact task output, fix, and fresh recovery without parsing logs", async () => {
    const h = await createHarness();
    try {
      h.server.setStatus({
        generation: 5,
        state: "passed",
        trigger: "src/main.ts",
        commands: ["make all"],
        durationMs: 42,
      });
      await h.sessionStart();

      await h.worktree.edit("src/main.ts", "export const version = 2;\n");
      await h.toolCall({
        type: "tool_call",
        toolCallId: "t1",
        toolName: "edit",
        params: { path: "src/main.ts" },
      });
      await h.toolResult({
        type: "tool_result",
        toolCallId: "t1",
        toolName: "edit",
        input: { path: "src/main.ts" },
        content: [],
        isError: false,
      });

      // failing run with a 45-line server tail: observe must truncate to 40
      const failures = Array.from({ length: 45 }, (_, index) => `error: line ${index}`);
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"], failures });
      const failedPromise = runTool(
        h.tool("watcher_observe"),
        { wait: true, afterGeneration: 5 },
        h.ctx,
      );
      await h.waitForNextSubscribe();
      h.server.startRun();
      h.server.completeRun({ outcome: "failed", failures });
      const failed = await failedPromise;
      expect(failed.details).toMatchObject({
        outcome: "terminal",
        generation: 6,
        state: "failed",
        truncated: true,
        nextAction: "watcher_output generation=6",
      });
      expect(failed.details.failures).toHaveLength(40);
      expect(failed.content[0]!.text).toContain("FAIL gen=6");

      // exact task output retrieval (typed details, no log parsing)
      h.server.scriptOutput(6, "run integration", {
        content: "boom: assertion failed\nat src/main.ts:1\n",
        lines: 2,
        observedBytes: 8192,
        retainedBytes: 4096,
        truncated: true,
      });
      const output = await runTool(
        h.tool("watcher_output"),
        { generation: 6, task: "run integration", tail: 10 },
        h.ctx,
      );
      expect(output.details).toMatchObject({
        generation: 6,
        tasks: [
          {
            id: "run integration",
            stdout: {
              content: "boom: assertion failed\nat src/main.ts:1\n",
              lines: 2,
              observedBytes: 8192,
              retainedBytes: 4096,
              truncated: true,
            },
            stderr: null,
          },
        ],
      });

      // fix + fresh recovery
      await h.worktree.edit("src/main.ts", "export const version = 3;\n");
      await h.toolCall({
        type: "tool_call",
        toolCallId: "t2",
        toolName: "edit",
        params: { path: "src/main.ts" },
      });
      await h.toolResult({
        type: "tool_result",
        toolCallId: "t2",
        toolName: "edit",
        input: { path: "src/main.ts" },
        content: [],
        isError: false,
      });
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"] });
      const recoveryPromise = runTool(
        h.tool("watcher_observe"),
        { wait: true, afterGeneration: 6 },
        h.ctx,
      );
      await h.waitForNextSubscribe();
      h.server.startRun();
      h.server.completeRun({ outcome: "passed", durationMs: 9 });
      const recovered = await recoveryPromise;
      expect(recovered.details).toMatchObject({
        outcome: "terminal",
        generation: 7,
        state: "passed",
        correlation: "exact-overlap",
      });

      // final verification accepts the fixed fingerprint
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"] });
      const verifyPromise = runTool(h.tool("watcher_verify"), { target: "lint" }, h.ctx);
      await h.server.waitForCall("run");
      h.server.completeRun({ outcome: "passed" });
      expect((await verifyPromise).details).toMatchObject({ reason: "passed", generation: 8 });

      // no follow-up fired: this session handled the failure through its tools
      expect(h.sendMessage).not.toHaveBeenCalled();
    } finally {
      await h.cleanup();
    }
  });

  it("rapid edits: a superseded generation is never accepted as fresh", async () => {
    const h = await createHarness();
    try {
      h.server.setStatus({
        generation: 5,
        state: "passed",
        trigger: "src/main.ts",
        commands: ["make all"],
        durationMs: 42,
      });
      await h.sessionStart();

      await h.worktree.edit("src/main.ts", "export const version = 2;\n");
      await h.toolResult({
        type: "tool_result",
        toolCallId: "t1",
        toolName: "edit",
        input: { path: "src/main.ts" },
        content: [],
        isError: false,
      });

      // first edit triggers gen 6; a second rapid edit supersedes it
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"] });
      const waitPromise = runTool(
        h.tool("watcher_observe"),
        { wait: true, afterGeneration: 5 },
        h.ctx,
      );
      await h.waitForNextSubscribe();
      h.server.startRun();
      h.server.startRun({ trigger: "src/main.ts", commands: ["make all"] });
      h.server.completeRun({ outcome: "passed", durationMs: 5 });
      const superseded = await waitPromise;
      expect(superseded.details).toMatchObject({
        outcome: "superseded",
        generation: 7,
        supersedingGeneration: 7,
      });

      // the later checkpoint must come from a fresh verified run, not the
      // superseded observation; fingerprint contract stays authoritative
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"] });
      const verifyPromise = runTool(h.tool("watcher_verify"), { target: "lint" }, h.ctx);
      await h.server.waitForCall("run");
      h.server.completeRun({ outcome: "passed", durationMs: 5 });
      const verification = await verifyPromise;
      const details = verification.details as {
        reason: string;
        fingerprint: string;
        fingerprintBefore: string;
      };
      expect(details).toMatchObject({ reason: "passed", generation: 8 });
      expect(details.fingerprint).toBe(details.fingerprintBefore);
    } finally {
      await h.cleanup();
    }
  });

  it("abort cancels the exact generation; replacement work stays unaffected", async () => {
    const h = await createHarness();
    try {
      h.server.setStatus({
        generation: 5,
        state: "passed",
        trigger: "src/main.ts",
        commands: ["make all"],
        durationMs: 42,
      });
      await h.sessionStart();

      const controller = new AbortController();
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"] });
      const verifyPromise = runToolSignal(
        h.tool("watcher_verify"),
        { target: "lint" },
        h.ctx,
        controller.signal,
      );
      await h.server.waitForCall("run");

      // Let the schedule-ack round trip land so the tool recorded the exact
      // generation before aborting (abort-before-identity is a separate path).
      await flush(5);
      controller.abort();
      await h.server.waitForCall("cancel");

      h.server.completeRun({ outcome: "cancelled" });

      await expect(verifyPromise).rejects.toThrow(/ABORTED.*cleanup=cancelled/);

      // replacement run on the same target completes normally
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"] });
      const replacementPromise = runTool(h.tool("watcher_verify"), { target: "lint" }, h.ctx);
      await h.server.waitForCallCount("run", 2);

      h.server.completeRun({ outcome: "passed", durationMs: 6 });

      expect((await replacementPromise).details).toMatchObject({ reason: "passed" });

      // exactly one compare-and-cancel was sent, for the exact generation
      expect(h.server.calls.filter((call) => call === "cancel")).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  describe("protocol edges", () => {
    it("restart reports a fresh instance identity", async () => {
      const h = await createHarness();
      try {
        h.server.setStatus({
          generation: 5,
          state: "passed",
          trigger: "src/main.ts",
          commands: ["make all"],
          durationMs: 42,
        });
        await h.sessionStart();
        h.server.restart();
        h.server.setStatus({
          generation: 1,
          state: "passed",
          trigger: "src/main.ts",
          commands: ["make all"],
          durationMs: 42,
        });
        const after = await runTool(h.tool("watcher_observe"), { wait: false }, h.ctx);
        expect(after.details).toMatchObject({ generation: 1, state: "passed" });
        expect(after.details.instance).toMatchObject({ token: h.server.instanceToken });
        expect((after.details.instance as { token: string }).token).not.toBe("");
      } finally {
        await h.cleanup();
      }
    });

    it("capability downgrade falls back to legacy polling with polled freshness", async () => {
      const h = await createHarness();
      try {
        // Downgrade before session_start so the cached capability profile is legacy.
        h.server.downgradeToLegacy();
        await h.sessionStart();
        h.server.setStatus({
          generation: 3,
          state: "passed",
          trigger: "src/main.ts",
          commands: ["make all"],
          durationMs: 42,
        });
        const observed = await runTool(h.tool("watcher_observe"), { wait: false }, h.ctx);
        expect(observed.details).toMatchObject({
          generation: 3,
          state: "passed",
          source: "polled",
        });
        expect(observed.content[0]!.text).toContain("(polled)");
      } finally {
        await h.cleanup();
      }
    });

    it("rejects sequential verification before scheduling when unsupported", async () => {
      const h = await createHarness();
      try {
        h.server.setFeatures({ sequentialOverride: false });
        await h.sessionStart();

        await expect(
          runTool(h.tool("watcher_verify"), { target: "lint", sequential: true }, h.ctx),
        ).rejects.toThrow("fzz run lint --sequential locally");
        expect(h.server.calls).not.toContain("run");
      } finally {
        await h.cleanup();
      }
    });

    it("timeout is reported as an explicit outcome, never a stale truth", async () => {
      const h = await createHarness();
      try {
        await h.sessionStart();
        h.server.hangNext("subscribe");
        const result = await runTool(
          h.tool("watcher_observe"),
          { wait: true, timeoutSeconds: 1 },
          h.ctx,
        );
        expect(result.details).toMatchObject({ outcome: "timeout" });
      } finally {
        await h.cleanup();
      }
    });

    it("no-match target selection fails with an actionable error", async () => {
      const h = await createHarness();
      try {
        await h.sessionStart();
        h.server.setTargets([{ name: "lint", commands: ["npm run lint"] }]);
        await expect(runTool(h.tool("watcher_verify"), { target: "nope" }, h.ctx)).rejects.toThrow(
          /No Funzzy target matching "nope"/,
        );
      } finally {
        await h.cleanup();
      }
    });

    it("malformed server payload becomes an unknown outcome with an actionable message", async () => {
      const h = await createHarness();
      try {
        await h.sessionStart();
        h.server.malformedNext("subscribe");
        const result = await runTool(h.tool("watcher_observe"), { wait: false }, h.ctx);
        expect(result.details).toMatchObject({ outcome: "unknown" });
        expect(String(result.details.message)).toContain("Funzzy");
      } finally {
        await h.cleanup();
      }
    });

    it("reports no retained output as an actionable error", async () => {
      const h = await createHarness();
      try {
        await h.sessionStart();
        await expect(runTool(h.tool("watcher_output"), { generation: 4 }, h.ctx)).rejects.toThrow(
          /no retained output/,
        );
      } finally {
        await h.cleanup();
      }
    });
  });

  it("two sessions: one failure is delivered once to the correct owner; reconnect replay never duplicates", async () => {
    const h = await createHarness();
    const piB = createPi();
    funzzyStatus(piB.pi as never);
    const ctxB = createCtx(h.worktree.dir, "session-2");
    try {
      h.server.setStatus({
        generation: 5,
        state: "passed",
        trigger: "src/main.ts",
        commands: ["make all"],
        durationMs: 42,
      });
      await h.sessionStart();
      await piB.handlers.get("session_start")!(undefined, ctxB);
      await flush();

      // session A makes a worktree edit → becomes the automatic responder
      await h.toolCall({
        type: "tool_call",
        toolCallId: "a1",
        toolName: "edit",
        params: { path: "src/main.ts" },
      });

      // watcher fails generation 6; both sessions observe the same snapshot
      h.server.setNextRun({ trigger: "src/main.ts", commands: ["make all"], failures: ["boom"] });
      h.server.startRun();
      h.server.completeRun({ outcome: "failed", failures: ["boom"] });
      // Event-driven: pushes delivered, then the at-most-once delivery lands.
      await h.server.waitForPushCount(2);
      await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(piB.sendMessage).toHaveBeenCalledTimes(0);

      // subscription drop + reconnect replays the failed snapshot: no duplicate
      h.server.closeSubscriptions();
      await h.server.waitForCallCount("subscribe", 3);
      await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(piB.sendMessage).toHaveBeenCalledTimes(0);
    } finally {
      await h.cleanup();
    }
  });

  it("tool contracts are deterministic snapshots", async () => {
    const h = await createHarness();
    try {
      await h.sessionStart();
      expect(h.tools.map((tool) => tool.name)).toEqual([
        "watcher_status",
        "watcher_targets",
        "watcher_observe",
        "watcher_output",
        "watcher_cancel",
        "watcher_verify",
      ]);
      expect(h.tool("watcher_observe").description).toContain("without triggering work");
      expect(h.tool("watcher_verify").description).toContain("freshness proof");
      expect(h.tool("watcher_output").description).toContain("this is not a status call");
    } finally {
      await h.cleanup();
    }
  });
});
