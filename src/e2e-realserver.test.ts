import { describe, expect, it, vi } from "vitest";
import { execFile as execFileCallback, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import funzzyStatus from "./index.js";

/**
 * TASK-0084 AC3: one-hop failure-evidence retrieval against the REAL funzzy
 * binary (not a scripted server). Proves the shipped 2.0.0 output contract:
 * the extension's verify result carries the exact generation, `watcher_output`
 * retrieves bounded evidence in ONE call with no retry permutation or schema
 * error, and the returned tool result stays under the Pi transport bound.
 *
 * The test skips itself when no built `fzz` binary is available (standalone
 * pi-watcher runs without a funzzy checkout); the funzzy candidate gate runs
 * it with the binary present.
 */

const here = dirname(fileURLToPath(import.meta.url));
// src/ -> pi-watcher -> funzzy checkout root (binary built by the funzzy gate).
const fzzBin = process.env.FUNZZY_BIN ?? join(here, "../../target/debug/fzz");
const hasFzz = existsSync(fzzBin);

const execFile = promisify(execFileCallback);

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  return env;
}

function createPi() {
  const tools: Array<{
    name: string;
    execute: (...args: unknown[]) => Promise<unknown>;
  }> = [];
  const activeTools = new Set<string>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    }),
    registerTool: vi.fn(
      (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
        tools.push(tool);
        activeTools.add(tool.name);
      },
    ),
    registerCommand: vi.fn(() => undefined),
    registerShortcut: vi.fn(() => undefined),
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
    sendMessage: vi.fn(),
  };
  return { pi, tools, handlers };
}

function createCtx(cwd: string) {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "session-realserver" },
    ui: { setStatus: vi.fn(), theme: { fg: () => "" } },
  };
}

async function runTool(
  tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>,
  name: string,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Tool ${name} not registered`);
  return (await tool.execute("1", params, undefined, undefined, ctx)) as {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  };
}

async function waitForSocket(socketPath: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const socket = await import("node:net").then(({ connect }) => connect(socketPath));
      socket.destroy();
      return;
    } catch {
      if (Date.now() > deadline)
        throw new Error(`fzz control socket never appeared: ${socketPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe.skipIf(!hasFzz)("real funzzy binary one-hop evidence (TASK-0084)", () => {
  it("verify failure then one watcher_output call returns bounded evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-watcher-realserver-"));
    const socketPath = join(dir, "funzzy.sock");
    const git = (args: string[]): void => {
      execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
    };
    git(["init", "-q"]);
    git(["config", "user.email", "e2e@example.com"]);
    git(["config", "user.name", "e2e"]);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, ".watch.yaml"),
      `on:\n  socket: funzzy.sock\njobs:\n  - name: build @final\n    run: 'echo boom >&2; exit 3'\n    change: 'src/**'\n`,
    );
    await writeFile(join(dir, "src/main.ts"), "export const version = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "baseline"]);

    const child = spawn(fzzBin, [], {
      cwd: dir,
      env: { ...process.env, FUNZZY_COLORED: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    try {
      await waitForSocket(socketPath);

      const { pi, tools, handlers } = createPi();
      funzzyStatus(pi as never);
      const ctx = createCtx(dir);
      // Real Pi fires session_start before any tool is callable (lazy gate).
      await handlers.get("session_start")!(undefined, ctx);

      // One-hop loop (real agent path): verify the failing target — it fails
      // and the tool reports the failure — then read the exact generation from
      // the correlated status snapshot (never parsed from prose), then
      // retrieve bounded evidence in ONE output call.
      const verifyError = await runTool(tools, "watcher_verify", { target: "build @final" }, ctx)
        .then(() => null)
        .catch((error: Error) => error);
      expect(verifyError, "the failing target must fail the verification").not.toBeNull();
      expect(verifyError!.message).toContain("FAIL");
      expect(verifyError!.message).toContain("exit status: 3");

      const observed = await runTool(tools, "watcher_observe", {}, ctx);
      const status = observed.details as { generation?: number; state?: string };
      expect(status.generation, "observe must expose the exact generation").toBeTypeOf("number");
      expect(status.state).toBe("failed");

      const output = await runTool(
        tools,
        "watcher_output",
        { generation: status.generation, tail: 20 },
        ctx,
      );
      const text = output.content[0]!.text;
      expect(text, "one call must return the failing evidence").toContain("boom");
      // Transport bound: the tool result must stay far below the Pi cap.
      expect(text.length, "tool result must be transport-bounded").toBeLessThan(64 * 1024);
      const outputDetails = output.details as { generation?: number; tasks?: unknown[] };
      expect(outputDetails.generation).toBe(status.generation);
      expect(Array.isArray(outputDetails.tasks)).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 2_000);
      });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
