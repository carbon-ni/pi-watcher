import { describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import funzzyStatus from "./index.js";

/**
 * Real-watcher smoke (contract §8 legacy fallback): drives the real
 * composition root against the actual `fzz` binary over a real control
 * socket. The current server only implements status/targets/run, so this
 * proves the negotiated legacy path — polled freshness labels, verify via
 * schedule + poll, output unavailable, cancel unknown. Skipped unless a
 * built binary is available (opt-in via FUNZZY_BIN, like the Rust
 * test-integration convention).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BIN = join(__dirname, "..", "..", "target", "release", "funzzy");
const BIN = process.env.FUNZZY_BIN ?? DEFAULT_BIN;
const binaryAvailable = existsSync(BIN);

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

function createPi() {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    }),
    registerTool: vi.fn((tool: RegisteredTool) => tools.push(tool)),
    registerCommand: vi.fn(),
    exec: vi.fn((command: string, args: string[], options: { cwd: string; timeout: number }) => {
      try {
        const result = execFileSync(command, args, {
          cwd: options.cwd,
          timeout: options.timeout,
          encoding: "utf8",
          env: gitEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { stdout: result, stderr: "", code: 0 };
      } catch (error) {
        const failure = error as { stdout?: Buffer; stderr?: Buffer; status?: number };
        return {
          stdout: String(failure.stdout ?? ""),
          stderr: String(failure.stderr ?? ""),
          code: failure.status ?? 1,
        };
      }
    }),
    sendMessage: vi.fn(),
  };
  return { pi, tools, handlers };
}

describe.skipIf(!binaryAvailable)("real watcher binary (legacy fallback)", () => {
  it("drives status, targets, observe, verify, output-unavailable, and cancel-unknown over the real control socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-real-watcher-"));
    let fzz: ReturnType<typeof spawn> | null = null;
    try {
      const git = (args: string[]): void => {
        execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
      };
      git(["init", "-q"]);
      git(["config", "user.email", "smoke@example.com"]);
      git(["config", "user.name", "smoke"]);
      writeFileSync(
        join(dir, ".watch.yaml"),
        [
          "on:",
          '  change: ["src/**"]',
          "  socket: .tmp/funzzy.sock",
          "tasks:",
          "  - name: lint",
          '    run: "test -f src/ok.txt"',
          '    change: ["src/**"]',
          "",
        ].join("\n"),
      );
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/main.txt"), "hello\n");
      writeFileSync(join(dir, "src/ok.txt"), "ok\n");
      git(["add", "-A"]);
      git(["commit", "-qm", "base"]);

      let fzzStderr = "";
      fzz = spawn(BIN, ["-c", ".watch.yaml"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
      fzz.stderr?.on("data", (chunk: Buffer) => {
        fzzStderr += chunk.toString("utf8");
      });
      const socketPath = join(dir, ".tmp/funzzy.sock");
      // Bounded, event-driven: a concurrently-rebuilt binary may take a moment
      // to come up; failure carries the watcher stderr for diagnosis.
      for (let i = 0; i < 100 && !existsSync(socketPath); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(existsSync(socketPath)).toBe(true);
      if (fzz.exitCode !== null) {
        throw new Error(`fzz exited early (${fzz.exitCode}): ${fzzStderr}`);
      }

      const { pi, tools, handlers } = createPi();
      funzzyStatus(pi as never);
      const ctx = {
        cwd: dir,
        hasUI: true,
        isProjectTrusted: () => true,
        isIdle: () => true,
        sessionManager: { getSessionId: () => "smoke" },
        ui: { setStatus: vi.fn(), theme: { fg: () => "" } },
      };
      const tool = (name: string): RegisteredTool => {
        const entry = tools.find((candidate) => candidate.name === name);
        if (entry === undefined) throw new Error(`Tool ${name} not registered`);
        return entry;
      };
      const run = (name: string, params: Record<string, unknown>): Promise<unknown> =>
        tool(name).execute("1", params, undefined, undefined, ctx);

      // Legacy negotiation: capabilities answers -32601 -> legacy profile.
      const observe = (await run("watcher_observe", { wait: false })) as {
        content: Array<{ text: string }>;
        details: { source: string; state: string; generation: number };
      };
      expect(observe.details.source).toBe("polled");
      expect(observe.content[0]!.text).toContain("(polled)");

      const targets = (await run("watcher_targets", {})) as {
        content: Array<{ text: string }>;
      };
      expect(targets.content[0]!.text).toContain("lint");

      // Legacy verify: schedule the target and await its terminal via polling.
      const verify = (await run("watcher_verify", { target: "lint" })) as {
        content: Array<{ text: string }>;
        details: { reason: string; state: string; fingerprint: string; fingerprintBefore: string };
      };
      expect(verify.details).toMatchObject({ reason: "passed", state: "passed" });
      expect(verify.details.fingerprint).toBe(verify.details.fingerprintBefore);
      expect(verify.content[0]!.text).toContain("PASS");

      // Output retrieval is unavailable on the real server today.
      await expect(run("watcher_output", { generation: 1 })).rejects.toThrow();

      // Cancel is a compare-and-cancel: an idle generation is a safe no-op.
      const cancel = (await run("watcher_cancel", { generation: 1 })) as {
        content: Array<{ text: string }>;
      };
      expect(cancel.content[0]!.text).toContain("not-running");

      // The lifecycle subscribes only on negotiated profiles; the legacy
      // profile keeps polling, so the status bar still renders.
      await handlers.get("session_start")!(undefined, ctx);
      expect(pi.sendMessage).not.toHaveBeenCalled();
    } finally {
      fzz?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
