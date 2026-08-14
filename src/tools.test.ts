import { describe, expect, it, vi } from "vitest";

import { registerTools } from "./tools.js";
import { createRequireTrustedConfig } from "./trusted-config.js";
import { formatStatus } from "./infra/client.js";
import { formatTargets } from "./domain/targets-presentation.js";
import type { WatcherVerification } from "./domain/verification.js";
import type { WatcherObservationResult } from "./domain/observation-result.js";
import type { WatcherObservation } from "./domain/observation.js";
import type { WatcherStatus, WatcherTarget } from "./domain/watcher.js";

const CONFIG = { socketPath: "/tmp/funzzy.sock", pollIntervalMs: 1_000 };

const STATUS: WatcherStatus = {
  generation: 7,
  state: "passed",
  trigger: "src/index.ts",
  commands: ["make all"],
  durationMs: 42,
  failures: [],
};

const TARGETS: WatcherTarget[] = [
  { name: "@agent-final", commands: ["make all"] },
  { name: "lint", commands: ["npm run lint"] },
];

const OBS_RUNNING: WatcherObservation = {
  sequence: 1,
  status: {
    generation: 5,
    state: "running",
    trigger: "src/index.ts",
    commands: ["make all"],
    durationMs: null,
    failures: [],
  },
  source: "subscription",
  freshness: "current",
  snapshot: null,
};

const OBS_PASSED: WatcherObservation = {
  sequence: 2,
  status: {
    generation: 5,
    state: "passed",
    trigger: "src/index.ts",
    commands: ["make all"],
    durationMs: 42,
    failures: [],
  },
  source: "subscription",
  freshness: "current",
  snapshot: null,
};

const OBSERVE_RESULT: WatcherObservationResult = {
  outcome: "terminal",
  instance: null,
  generation: 5,
  batchId: null,
  state: "passed",
  durationMs: 42,
  trigger: "src/index.ts",
  freshness: "current",
  source: "subscription",
  tasks: [],
  pending: null,
  failures: [],
  truncated: false,
  evidenceLines: 0,
  nextAction: null,
  supersedingGeneration: null,
  waitedMs: 0,
  message: null,
};

type RegisteredToolCapture = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

async function runTool(
  tool: RegisteredToolCapture | undefined,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolResult> {
  return (await tool!.execute("1", params, undefined, undefined, ctx)) as ToolResult;
}

function createPi() {
  const tools: RegisteredToolCapture[] = [];
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn((tool: RegisteredToolCapture) => tools.push(tool)),
    registerCommand: vi.fn(),
    exec: vi.fn(),
  };
  return { pi, tools };
}

function createDeps(overrides: Record<string, unknown> = {}) {
  const verification: WatcherVerification = {
    reason: "passed",
    target: "lint",
    matchMode: "exact",
    instance: null,
    generation: 7,
    freshness: "polled",
    source: "polled",
    fingerprint: "abc123",
    fingerprintBefore: "abc123",
    state: "passed",
    durationMs: 42,
    failures: [],
    pending: null,
    supersedingRunId: null,
    attemptCount: 1,
  };
  return {
    requireTrustedConfig: createRequireTrustedConfig(vi.fn().mockResolvedValue(CONFIG)),
    queryStatus: vi.fn().mockResolvedValue(STATUS),
    waitForRun: vi.fn().mockResolvedValue(STATUS),
    formatStatus,
    listTargets: vi.fn().mockResolvedValue(TARGETS),
    formatTargets,
    verifyRequest: vi.fn().mockResolvedValue(verification),
    worktreeFingerprint: vi.fn().mockResolvedValue("abc123"),
    createObservePort: vi.fn().mockResolvedValue({
      open: async function* () {
        yield OBS_RUNNING;
      },
    }),
    classifyObservationError: vi.fn<(error: unknown) => "disconnect" | "unknown">(() => "unknown"),
    requestObservation: vi.fn().mockResolvedValue(OBSERVE_RESULT),
    ...overrides,
  };
}

function trustedCtx(trusted = true) {
  return {
    cwd: "/project",
    isProjectTrusted: () => trusted,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "session-1" },
    ui: { setStatus: vi.fn(), theme: { fg: () => "" } },
  };
}

function registeredTool(tools: RegisteredToolCapture[], name: string) {
  return tools.find((entry) => entry.name === name);
}

describe("registerTools", () => {
  it("registers the four watcher-prefixed tools", () => {
    const { pi, tools } = createPi();

    registerTools(pi as never, createDeps());

    expect(tools.map((tool) => tool.name)).toEqual([
      "watcher_status",
      "watcher_targets",
      "watcher_observe",
      "watcher_verify",
    ]);
  });
});

describe("watcher_status", () => {
  it("returns the formatted status for a trusted configured project", async () => {
    const { pi, tools } = createPi();
    registerTools(pi as never, createDeps());

    const result = await runTool(registeredTool(tools, "watcher_status"), {}, trustedCtx());

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "PASS gen=7 tests=make all duration=42ms trigger=src/index.ts",
        },
      ],
      details: STATUS,
    });
  });

  it("waits for a running generation when requested", async () => {
    const { pi, tools } = createPi();
    const waitForRun = vi.fn().mockResolvedValue({ ...STATUS, generation: 8 });
    const queryStatus = vi.fn().mockResolvedValueOnce({ ...STATUS, state: "running" });
    registerTools(pi as never, createDeps({ waitForRun, queryStatus }));

    const result = await runTool(
      registeredTool(tools, "watcher_status"),
      { wait: true },
      trustedCtx(),
    );

    expect(waitForRun).toHaveBeenCalledWith(
      7,
      120_000,
      expect.any(Function),
      250,
      expect.any(Function),
      5_000,
    );
    expect(result.content[0]!.text).toBe(
      "PASS gen=8 tests=make all duration=42ms trigger=src/index.ts",
    );
  });

  it("reports wait progress through the update callback", async () => {
    const { pi, tools } = createPi();
    const running = { ...STATUS, state: "running" as const };
    const waitForRun = vi.fn(
      async (
        _runId: number,
        _timeoutMs: number,
        _readStatus: () => Promise<WatcherStatus>,
        _pollIntervalMs: number | undefined,
        onUpdate: ((status: WatcherStatus) => void) | undefined,
      ) => {
        onUpdate?.(running);
        return { ...STATUS, generation: 8 };
      },
    );
    registerTools(
      pi as never,
      createDeps({ waitForRun, queryStatus: vi.fn().mockResolvedValue(running) }),
    );
    const tool = registeredTool(tools, "watcher_status")!;
    const onUpdate =
      vi.fn<
        (update: { content: Array<{ type: "text"; text: string }>; details: WatcherStatus }) => void
      >();

    await tool.execute("1", { wait: true }, undefined, onUpdate, trustedCtx());

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const update = onUpdate.mock.calls[0]![0];
    expect(update.details).toEqual(running);
    expect(update.content[0]!.text).toMatch(/waited=\d+s/);
  });

  it("rejects untrusted projects", async () => {
    const { pi, tools } = createPi();
    registerTools(pi as never, createDeps());

    await expect(
      runTool(registeredTool(tools, "watcher_status"), {}, trustedCtx(false)),
    ).rejects.toThrow("Funzzy project configuration is not trusted");
  });

  it("rejects projects without on.socket config", async () => {
    const { pi, tools } = createPi();
    const requireTrustedConfig = createRequireTrustedConfig(vi.fn().mockResolvedValue(null));
    registerTools(pi as never, createDeps({ requireTrustedConfig }));

    await expect(
      runTool(registeredTool(tools, "watcher_status"), {}, trustedCtx()),
    ).rejects.toThrow("Funzzy on.socket is not configured in /project/.watch.yaml");
  });
});

describe("watcher_targets", () => {
  it("returns formatted targets from the control socket", async () => {
    const { pi, tools } = createPi();
    const listTargets = vi.fn().mockResolvedValue(TARGETS);
    registerTools(pi as never, createDeps({ listTargets }));

    const result = await runTool(registeredTool(tools, "watcher_targets"), {}, trustedCtx());

    expect(listTargets).toHaveBeenCalledWith(CONFIG.socketPath);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "- @agent-final: make all\n- lint: npm run lint",
        },
      ],
      details: { targets: TARGETS },
    });
  });
});

describe("watcher_observe", () => {
  it("returns a compact observation result for a trusted configured project", async () => {
    const { pi, tools } = createPi();
    registerTools(pi as never, createDeps());

    const result = await runTool(registeredTool(tools, "watcher_observe"), {}, trustedCtx());

    expect(result).toEqual({
      content: [{ type: "text", text: "PASS gen=5 freshness=current duration=42ms" }],
      details: OBSERVE_RESULT,
    });
  });

  it("waits with an explicit timeout and afterGeneration passthrough", async () => {
    const { pi, tools } = createPi();
    const requestObservation = vi.fn().mockResolvedValue(OBSERVE_RESULT);
    const port = {
      open: async function* () {
        yield OBS_RUNNING;
      },
    };
    const createObservePort = vi.fn().mockResolvedValue(port);
    registerTools(pi as never, createDeps({ requestObservation, createObservePort }));

    await runTool(
      registeredTool(tools, "watcher_observe"),
      { wait: true, afterGeneration: 4, timeoutSeconds: 90 },
      trustedCtx(),
    );

    expect(requestObservation).toHaveBeenCalledWith(
      {
        wait: true,
        afterGeneration: 4,
        timeoutMs: 90_000,
      },
      expect.objectContaining({ port }),
    );
  });

  it("uses a shorter default timeout for snapshots", async () => {
    const { pi, tools } = createPi();
    const requestObservation = vi.fn().mockResolvedValue(OBSERVE_RESULT);
    registerTools(pi as never, createDeps({ requestObservation }));

    await runTool(registeredTool(tools, "watcher_observe"), {}, trustedCtx());

    expect(requestObservation).toHaveBeenCalledWith(
      expect.objectContaining({ wait: false, timeoutMs: 10_000 }),
      expect.anything(),
    );
  });

  it("propagates the tool abort signal into the observation only", async () => {
    const { pi, tools } = createPi();
    const requestObservation = vi.fn().mockResolvedValue({ ...OBSERVE_RESULT, outcome: "aborted" });
    registerTools(pi as never, createDeps({ requestObservation }));
    const controller = new AbortController();
    const tool = registeredTool(tools, "watcher_observe")!;

    await tool.execute("1", { wait: true }, controller.signal, undefined, trustedCtx());

    expect(requestObservation).toHaveBeenCalledWith(
      expect.objectContaining({ wait: true }),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("rate-bounds progress updates to meaningful state changes or the heartbeat interval", async () => {
    vi.useFakeTimers();
    const { pi, tools } = createPi();
    const requestObservation = vi.fn(
      async (_request: unknown, deps: { onObservation?: (o: WatcherObservation) => void }) => {
        deps.onObservation?.(OBS_RUNNING);
        deps.onObservation?.(OBS_RUNNING);
        deps.onObservation?.(OBS_RUNNING);
        await vi.advanceTimersByTimeAsync(6_000);
        deps.onObservation?.(OBS_RUNNING);
        deps.onObservation?.(OBS_PASSED);
        return OBSERVE_RESULT;
      },
    );
    registerTools(pi as never, createDeps({ requestObservation }));
    const tool = registeredTool(tools, "watcher_observe")!;
    const onUpdate =
      vi.fn<
        (update: { content: Array<{ type: string; text: string }>; details: unknown }) => void
      >();

    await tool.execute(
      "1",
      { wait: true, updateIntervalSeconds: 5 },
      undefined,
      onUpdate,
      trustedCtx(),
    );

    // first observation, heartbeat after the interval, state change at the end
    expect(onUpdate).toHaveBeenCalledTimes(3);
    const texts = onUpdate.mock.calls.map((call) => call[0].content[0]!.text);
    expect(texts[0]!).toMatch(/^RUNNING gen=5 freshness=current/);
    expect(texts[0]!).toMatch(/waited=\d+s$/);
    expect(texts[2]!).toMatch(/^PASS gen=5 freshness=current/);
  });

  it("does not emit progress for a snapshot-only call", async () => {
    const { pi, tools } = createPi();
    const requestObservation = vi.fn().mockResolvedValue(OBSERVE_RESULT);
    registerTools(pi as never, createDeps({ requestObservation }));
    const tool = registeredTool(tools, "watcher_observe")!;
    const onUpdate = vi.fn();

    await tool.execute("1", {}, undefined, onUpdate, trustedCtx());

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("rejects untrusted projects before opening an observation port", async () => {
    const { pi, tools } = createPi();
    const createObservePort = vi.fn();
    registerTools(pi as never, createDeps({ createObservePort }));

    await expect(
      runTool(registeredTool(tools, "watcher_observe"), {}, trustedCtx(false)),
    ).rejects.toThrow("Funzzy project configuration is not trusted");
    expect(createObservePort).not.toHaveBeenCalled();
  });
});

describe("watcher_verify", () => {
  it("returns the compact final result with a stable fingerprint", async () => {
    const { pi, tools } = createPi();
    registerTools(pi as never, createDeps());

    const result = await runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx());

    expect(result.content).toEqual([
      {
        type: "text",
        text: "PASS gen=7 target=lint duration=42ms fingerprint=abc123",
      },
    ]);
    expect(result.details).toMatchObject({
      reason: "passed",
      target: "lint",
      fingerprint: "abc123",
    });
  });

  it("selects the exact target name by default and passes the timeout", async () => {
    const { pi, tools } = createPi();
    const verifyRequest = vi.fn().mockResolvedValue({
      reason: "passed",
      fingerprint: "abc123",
      durationMs: null,
    });
    registerTools(pi as never, createDeps({ verifyRequest }));

    await runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx());

    expect(verifyRequest).toHaveBeenCalledWith(
      CONFIG,
      { target: "@agent-final", matchMode: "exact", timeoutMs: 120_000 },
      expect.any(Function),
      undefined,
    );
  });

  it("runs the exact target and fingerprint reads through Pi exec", async () => {
    const { pi, tools } = createPi();
    const worktreeFingerprint = vi.fn(
      async (
        _cwd: string,
        exec: (
          command: string,
          args: string[],
          options: { cwd: string; timeout: number },
        ) => Promise<unknown>,
      ) => {
        await exec("git", ["status"], { cwd: "/project", timeout: 1_000 });
        return "abc123";
      },
    );
    const verifyRequest = vi.fn(
      async (_config: unknown, _request: unknown, fingerprint: () => Promise<string>) => {
        await fingerprint();
        return { reason: "passed", fingerprint: "abc123", durationMs: null };
      },
    );
    registerTools(pi as never, createDeps({ worktreeFingerprint, verifyRequest }));

    await runTool(registeredTool(tools, "watcher_verify"), { target: "lint" }, trustedCtx());

    expect(pi.exec).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({ cwd: "/project", timeout: 1_000 }),
    );
  });

  it("rejects a requested name that matches no exact target", async () => {
    const { pi, tools } = createPi();
    const listTargets = vi
      .fn()
      .mockResolvedValue([{ name: "final checks @agent-final", commands: ["make all"] }]);
    registerTools(pi as never, createDeps({ listTargets }));

    await expect(
      runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx()),
    ).rejects.toThrow(
      'No exact Funzzy target named "@agent-final"; candidates: final checks @agent-final',
    );
  });

  it("never picks an ambiguous substring match silently", async () => {
    const { pi, tools } = createPi();
    const listTargets = vi.fn().mockResolvedValue([
      { name: "final checks @agent-final", commands: ["make all"] },
      { name: "final checks @agent-slow", commands: ["make integration"] },
    ]);
    const verifyRequest = vi.fn();
    registerTools(pi as never, createDeps({ listTargets, verifyRequest }));

    await expect(
      runTool(
        registeredTool(tools, "watcher_verify"),
        { target: "final checks", matchMode: "substring" },
        trustedCtx(),
      ),
    ).rejects.toThrow(/ambiguous/);
    expect(verifyRequest).not.toHaveBeenCalled();
  });

  it("rejects a failed verification run with evidence", async () => {
    const { pi, tools } = createPi();
    const verifyRequest = vi.fn().mockResolvedValue({
      reason: "failed",
      target: "lint",
      generation: 7,
      failures: ["boom"],
      fingerprint: "abc123",
    });
    registerTools(pi as never, createDeps({ verifyRequest }));

    await expect(
      runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx()),
    ).rejects.toThrow(/FAIL gen=7 target=lint failures=1/);
  });

  it("rejects a stale verification with the explicit reason", async () => {
    const { pi, tools } = createPi();
    const verifyRequest = vi.fn().mockResolvedValue({
      reason: "stale",
      target: "lint",
      generation: 7,
      failures: [],
      fingerprint: "after",
    });
    registerTools(pi as never, createDeps({ verifyRequest }));

    await expect(
      runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx()),
    ).rejects.toThrow("STALE gen=7 target=lint");
  });
});
