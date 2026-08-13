import { describe, expect, it, vi } from "vitest";

import { registerTools } from "./tools.js";
import { createRequireTrustedConfig } from "./trusted-config.js";
import { formatStatus } from "./infra/client.js";
import { formatTargets } from "./domain/targets-presentation.js";
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

const TARGETS: WatcherTarget[] = [{ name: "lint", commands: ["npm run lint"] }];

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
  return {
    requireTrustedConfig: createRequireTrustedConfig(vi.fn().mockResolvedValue(CONFIG)),
    queryStatus: vi.fn().mockResolvedValue(STATUS),
    waitForRun: vi.fn().mockResolvedValue(STATUS),
    formatStatus,
    listTargets: vi.fn().mockResolvedValue(TARGETS),
    formatTargets,
    requestRun: vi.fn().mockResolvedValue(10),
    requestStableRun: vi.fn().mockResolvedValue(STATUS),
    worktreeFingerprint: vi.fn().mockResolvedValue("abc123"),
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
  it("registers the three watcher-prefixed tools", () => {
    const { pi, tools } = createPi();

    registerTools(pi as never, createDeps());

    expect(tools.map((tool) => tool.name)).toEqual([
      "watcher_status",
      "watcher_targets",
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
      content: [{ type: "text", text: "- lint: npm run lint" }],
      details: { targets: TARGETS },
    });
  });
});

describe("watcher_verify", () => {
  it("returns the compact final result with a stable fingerprint", async () => {
    const { pi, tools } = createPi();
    registerTools(pi as never, createDeps());

    const result = await runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx());

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "PASS gen=7 tests=make all duration=42ms trigger=src/index.ts fingerprint=abc123",
        },
      ],
      details: { ...STATUS, fingerprint: "abc123" },
    });
  });

  it("requests the named target by default", async () => {
    const { pi, tools } = createPi();
    const requestRun = vi.fn().mockResolvedValue(10);
    const requestStableRun = vi.fn(async (options: { request: () => Promise<number> }) => {
      await options.request();
      return STATUS;
    });
    registerTools(pi as never, createDeps({ requestRun, requestStableRun }));

    await runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx());

    expect(requestRun).toHaveBeenCalledWith(CONFIG.socketPath, "@agent-final");
  });

  it("runs the named target with live status and fingerprint reads", async () => {
    const { pi, tools } = createPi();
    const requestRun = vi.fn().mockResolvedValue(10);
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
    const requestStableRun = vi.fn(
      async (options: {
        request: () => Promise<number>;
        readStatus: () => Promise<WatcherStatus>;
        isWorktreeCurrent: () => Promise<boolean>;
      }) => {
        await options.request();
        await options.readStatus();
        await options.isWorktreeCurrent();
        return STATUS;
      },
    );
    registerTools(pi as never, createDeps({ requestRun, worktreeFingerprint, requestStableRun }));

    const result = await runTool(
      registeredTool(tools, "watcher_verify"),
      { target: "lint" },
      trustedCtx(),
    );

    expect(requestRun).toHaveBeenCalledWith(CONFIG.socketPath, "lint");
    expect(pi.exec).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({ cwd: "/project", timeout: 1_000 }),
    );
    expect(result.content[0]!.text).toBe(
      "PASS gen=7 tests=make all duration=42ms trigger=src/index.ts fingerprint=abc123",
    );
  });

  it("rejects a worktree that changed during verification", async () => {
    const { pi, tools } = createPi();
    const worktreeFingerprint = vi.fn().mockResolvedValueOnce("before").mockResolvedValue("after");
    registerTools(pi as never, createDeps({ worktreeFingerprint }));

    await expect(
      runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx()),
    ).rejects.toThrow("STALE gen=7: worktree changed during Funzzy verification");
  });

  it("rejects a failed verification run", async () => {
    const { pi, tools } = createPi();
    const requestStableRun = vi
      .fn()
      .mockResolvedValue({ ...STATUS, state: "failed", failures: ["boom"] });
    registerTools(pi as never, createDeps({ requestStableRun }));

    await expect(
      runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx()),
    ).rejects.toThrow(/FAIL gen=7 failures=1/);
  });
});
