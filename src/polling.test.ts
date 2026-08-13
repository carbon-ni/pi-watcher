import { afterEach, describe, expect, it, vi } from "vitest";

import { createPollingLifecycle } from "./polling.js";
import type { WatcherStatus } from "./domain/watcher.js";
import { createFailureNotifier } from "./domain/failure-notifier.js";
import { recordsAgentActivity } from "./domain/activity.js";
import { renderWatcherFooter, watcherStatusColor } from "./domain/status-presentation.js";
import { formatStatus } from "./infra/client.js";

const CONFIG = { socketPath: "/tmp/funzzy.sock", pollIntervalMs: 1_000 };

const STATUS: WatcherStatus = {
  generation: 7,
  state: "passed",
  trigger: "src/index.ts",
  commands: ["make all"],
  durationMs: 42,
  failures: [],
};

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    readConfig: vi.fn().mockResolvedValue(CONFIG),
    createFailureNotifier,
    queryStatus: vi.fn().mockResolvedValue(STATUS),
    readResponder: vi.fn().mockResolvedValue(null),
    recordsAgentActivity,
    recordAutomaticResponder: vi.fn().mockResolvedValue(undefined),
    isSessionDisconnected: vi.fn().mockResolvedValue(false),
    renderWatcherFooter,
    watcherStatusColor,
    formatStatus,
    ...overrides,
  };
}

type Deps = ReturnType<typeof createDeps>;

function createHarness(overrides: Partial<Deps> = {}) {
  const deps = createDeps(overrides);
  const sendMessage = vi.fn();
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage,
  };
  const setStatus = vi.fn();
  const ctx = {
    cwd: "/project",
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      setStatus,
      theme: { fg: (color: string, text: string) => `${color}:${text}` },
    },
  };
  const lifecycle = createPollingLifecycle(pi as never, deps);
  return { ctx, deps, lifecycle, sendMessage, setStatus };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("session start", () => {
  it("polls immediately and publishes the status bar", async () => {
    vi.useFakeTimers();
    const { ctx, deps, lifecycle, setStatus } = createHarness();

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.queryStatus).toHaveBeenCalledWith(CONFIG.socketPath);
    expect(setStatus).toHaveBeenCalledWith("watcher-status", "success:watcher: passed #7 42ms");

    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
    expect(deps.queryStatus).toHaveBeenCalledTimes(2);
  });

  it("does not poll when the project is untrusted", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness();
    ctx.isProjectTrusted = () => false;

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.queryStatus).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("does not poll when on.socket is not configured", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness({
      readConfig: vi.fn().mockResolvedValue(null),
    });

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.queryStatus).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("does not poll when there is no UI", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness();
    ctx.hasUI = false;

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.queryStatus).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("publishes unavailable watcher state when polling fails", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness();
    deps.queryStatus.mockRejectedValueOnce(new Error("socket unavailable"));

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(setStatus).toHaveBeenCalledWith("watcher-status", "warning:watcher: unavailable");
  });

  it("restarting the session keeps exactly one polling interval", async () => {
    vi.useFakeTimers();
    const { ctx, deps, lifecycle } = createHarness();

    await lifecycle.sessionStart({} as never, ctx as never);
    await lifecycle.sessionStart({} as never, ctx as never);

    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
    expect(deps.queryStatus).toHaveBeenCalledTimes(3);
  });
});

describe("failure delivery", () => {
  it("delivers an idle failure once through Pi follow-up", async () => {
    const failed: WatcherStatus = { ...STATUS, state: "failed", failures: ["boom"] };
    const { ctx, lifecycle, sendMessage } = createHarness({
      queryStatus: vi.fn().mockResolvedValue(failed),
      readResponder: vi.fn().mockResolvedValue({ mode: "automatic", sessionId: "session-1" }),
    });

    await lifecycle.sessionStart({} as never, ctx as never);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "funzzy-failure",
        display: true,
        details: failed,
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    await lifecycle.agentSettled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not deliver when the responder belongs to another session", async () => {
    const failed: WatcherStatus = { ...STATUS, state: "failed", failures: ["boom"] };
    const { ctx, lifecycle, sendMessage } = createHarness({
      queryStatus: vi.fn().mockResolvedValue(failed),
      readResponder: vi.fn().mockResolvedValue({ mode: "pinned", sessionId: "session-2" }),
    });

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("activity attribution", () => {
  it("records the responder for worktree activity tools", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.toolCall({ toolName: "edit" } as never, ctx as never);

    expect(deps.recordAutomaticResponder).toHaveBeenCalledWith(CONFIG.socketPath, "session-1");
  });

  it("ignores non-activity tool calls", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.toolCall({ toolName: "watcher_status" } as never, ctx as never);

    expect(deps.recordAutomaticResponder).not.toHaveBeenCalled();
  });

  it("swallows responder write failures so tool calls never block", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    deps.recordAutomaticResponder.mockRejectedValue(new Error("disk full"));
    await lifecycle.sessionStart({} as never, ctx as never);

    await expect(
      lifecycle.toolCall({ toolName: "bash" } as never, ctx as never),
    ).resolves.toBeUndefined();
  });
});

describe("session disconnect", () => {
  it("does not poll when the session is disconnected", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness({
      isSessionDisconnected: vi.fn().mockResolvedValue(true),
    });

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.queryStatus).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("watcher-status", "muted:watcher: disconnected");
  });

  it("stops polling and clears the status bar on disconnect", async () => {
    vi.useFakeTimers();
    const { ctx, deps, lifecycle, setStatus } = createHarness();

    await lifecycle.sessionStart({} as never, ctx as never);
    await lifecycle.disconnect(ctx as never);
    const callsAtDisconnect = deps.queryStatus.mock.calls.length;

    expect(setStatus).toHaveBeenLastCalledWith("watcher-status", undefined);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.queryStatus.mock.calls.length).toBe(callsAtDisconnect);
  });

  it("disconnect is a no-op when nothing is running", async () => {
    const { ctx, deps, lifecycle } = createHarness();

    await expect(lifecycle.disconnect(ctx as never)).resolves.toBeUndefined();
    expect(deps.queryStatus).not.toHaveBeenCalled();
  });

  it("stops activity attribution after disconnect", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.disconnect(ctx as never);
    await lifecycle.toolCall({ toolName: "edit" } as never, ctx as never);

    expect(deps.recordAutomaticResponder).not.toHaveBeenCalled();
  });

  it("does not attribute activity when started disconnected", async () => {
    const { ctx, deps, lifecycle } = createHarness({
      isSessionDisconnected: vi.fn().mockResolvedValue(true),
    });
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.toolCall({ toolName: "edit" } as never, ctx as never);

    expect(deps.recordAutomaticResponder).not.toHaveBeenCalled();
  });

  it("connect resumes polling after disconnect", async () => {
    vi.useFakeTimers();
    const { ctx, deps, lifecycle } = createHarness();

    await lifecycle.sessionStart({} as never, ctx as never);
    await lifecycle.disconnect(ctx as never);
    await lifecycle.connect(ctx as never);
    const callsAfterConnect = deps.queryStatus.mock.calls.length;

    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
    expect(deps.queryStatus.mock.calls.length).toBe(callsAfterConnect + 1);
  });

  it("connect resumes a session that started disconnected", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness({
      isSessionDisconnected: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    });

    await lifecycle.sessionStart({} as never, ctx as never);
    expect(deps.queryStatus).not.toHaveBeenCalled();

    await lifecycle.connect(ctx as never);

    expect(deps.queryStatus).toHaveBeenCalledWith(CONFIG.socketPath);
    expect(setStatus).toHaveBeenLastCalledWith("watcher-status", "success:watcher: passed #7 42ms");
  });

  it("does not deliver new failures after disconnect", async () => {
    const failed: WatcherStatus = { ...STATUS, state: "failed", failures: ["boom"] };
    const { ctx, lifecycle, sendMessage } = createHarness({
      queryStatus: vi.fn().mockResolvedValue(failed),
      readResponder: vi.fn().mockResolvedValue({ mode: "automatic", sessionId: "session-1" }),
    });

    await lifecycle.sessionStart({} as never, ctx as never);
    const callsAtDisconnect = sendMessage.mock.calls.length;
    await lifecycle.disconnect(ctx as never);
    await lifecycle.agentSettled();

    expect(sendMessage.mock.calls.length).toBe(callsAtDisconnect);
  });
});

describe("session shutdown", () => {
  it("stops polling, clears the status bar, and is idempotent", async () => {
    vi.useFakeTimers();
    const { ctx, deps, lifecycle, setStatus } = createHarness();

    await lifecycle.sessionStart({} as never, ctx as never);
    await lifecycle.sessionShutdown(ctx as never);
    const callsAtShutdown = deps.queryStatus.mock.calls.length;

    expect(setStatus).toHaveBeenLastCalledWith("watcher-status", undefined);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.queryStatus.mock.calls.length).toBe(callsAtShutdown);

    await expect(lifecycle.sessionShutdown(ctx as never)).resolves.toBeUndefined();
  });
});

describe("agent settled", () => {
  it("re-polls current status", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.agentSettled();

    expect(deps.queryStatus).toHaveBeenCalledTimes(2);
  });
});
