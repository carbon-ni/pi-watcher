import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { createPollingLifecycle, type PollingDeps } from "./polling.js";
import { createPollingPort, type QueryStatusFn } from "./infra/observer.js";
import type { ObserverPort } from "./application/observer.js";
import { decodeWatcherCapabilities } from "./domain/capabilities.js";
import capabilitiesFixture from "./domain/fixtures/capabilities.json" with { type: "json" };
import type { FunzzyConfig } from "./infra/config.js";
import type { Responder } from "./infra/ownership.js";
import type { WatcherCapabilityProfile } from "./domain/capabilities.js";
import type { WatcherStatus } from "./domain/watcher.js";
import { createFailureNotifier } from "./domain/failure-notifier.js";
import { recordsAgentActivity } from "./domain/activity.js";
import { renderWatcherFooter, watcherStatusColor } from "./domain/status-presentation.js";
import { formatStatus } from "./infra/client.js";

const CONFIG = { socketPath: "/tmp/funzzy.sock", pollIntervalMs: 1_000 };
const NEGOTIATED_PROFILE = decodeWatcherCapabilities(capabilitiesFixture);

const STATUS: WatcherStatus = {
  generation: 7,
  state: "passed",
  trigger: "src/index.ts",
  commands: ["make all"],
  durationMs: 42,
  failures: [],
};

const SUBSCRIPTION_PORT_STUB: ObserverPort = {
  async *open() {
    yield {
      sequence: 1,
      status: STATUS,
      source: "subscription",
      freshness: "current",
      snapshot: null,
    };
  },
};

interface TestDeps extends PollingDeps {
  queryStatus: ReturnType<typeof vi.fn<QueryStatusFn>>;
  readConfig: ReturnType<typeof vi.fn<(cwd: string) => Promise<FunzzyConfig | null>>>;
  loadCapabilities: ReturnType<
    typeof vi.fn<(socketPath: string) => Promise<WatcherCapabilityProfile>>
  >;
  invalidateCapabilities: ReturnType<typeof vi.fn<() => void>>;
  createSubscriptionPort: ReturnType<typeof vi.fn<(socketPath: string) => ObserverPort>>;
  createPollingPort: ReturnType<
    typeof vi.fn<(socketPath: string, pollIntervalMs: number) => ObserverPort>
  >;
  readResponder: ReturnType<typeof vi.fn<(socketPath: string) => Promise<Responder | null>>>;
  recordAutomaticResponder: ReturnType<
    typeof vi.fn<(socketPath: string, sessionId: string) => Promise<void>>
  >;
  isSessionDisconnected: ReturnType<
    typeof vi.fn<(socketPath: string, sessionId: string) => Promise<boolean>>
  >;
}

type Deps = TestDeps;

function createDeps(overrides: Partial<Deps> = {}): Deps {
  const queryStatus = vi.fn<QueryStatusFn>().mockResolvedValue(STATUS);
  const deps: Deps = {
    readConfig: vi.fn<(cwd: string) => Promise<FunzzyConfig | null>>().mockResolvedValue(CONFIG),
    createFailureNotifier,
    loadCapabilities: vi
      .fn<(socketPath: string) => Promise<WatcherCapabilityProfile>>()
      .mockResolvedValue({
        source: "legacy",
        protocolVersion: "1.0",
        schemaVersion: 1,
        instance: { token: "", startedAtEpochMs: null },
        methods: ["status", "targets", "run"],
        optionalFields: [],
        limits: {
          outputRetentionBytes: 0,
          maxResponseBytes: 65536,
          maxEvidenceLines: 40,
          outputSchemaVersion: null,
          outputModes: [],
          outputPageSizeMax: null,
          outputMaxBytesEffective: null,
        },
        features: {
          atomicAwait: false,
          subscription: false,
          correlatedSnapshots: false,
          outputRetrieval: false,
          pendingWork: false,
          durationEstimates: false,
          sequentialOverride: false,
        },
      }),
    invalidateCapabilities: vi.fn(),
    createSubscriptionPort: vi.fn(() => SUBSCRIPTION_PORT_STUB),
    createPollingPort: vi.fn(),
    readResponder: vi.fn().mockResolvedValue(null),
    recordsAgentActivity,
    recordAutomaticResponder: vi.fn().mockResolvedValue(undefined),
    isSessionDisconnected: vi.fn().mockResolvedValue(false),
    isHandledFailure: vi.fn<(sessionId: string, key: string) => boolean>(() => false),
    claimFailureDelivery: vi.fn(async () => true),
    recordEditCheckpoint: vi.fn(),
    readEditCheckpoint: vi.fn().mockReturnValue(null),
    clearEditCheckpoint: vi.fn(),
    renderWatcherFooter,
    watcherStatusColor,
    formatStatus,
    queryStatus,
    ...overrides,
  };
  // The polling port must read through the (possibly overridden) queryStatus mock.
  deps.createPollingPort = vi.fn((socketPath: string, pollIntervalMs: number) =>
    createPollingPort(deps.queryStatus, socketPath, pollIntervalMs),
  );
  return deps;
}

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

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("session start", () => {
  it("observes immediately and publishes the status bar", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness();

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.queryStatus).toHaveBeenCalledWith(CONFIG.socketPath);
    expect(setStatus).toHaveBeenCalledWith(
      "watcher-status",
      "success:watcher: passed #7 42ms (polled)",
    );
  });

  it("marks legacy polling in the footer and negotiates capabilities", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness();

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.loadCapabilities).toHaveBeenCalledWith(CONFIG.socketPath);
    expect(setStatus).toHaveBeenCalledWith(
      "watcher-status",
      "success:watcher: passed #7 42ms (polled)",
    );
  });

  it("uses the subscription port when capabilities support it", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness({
      loadCapabilities: vi.fn().mockResolvedValue(NEGOTIATED_PROFILE),
    });

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.createSubscriptionPort).toHaveBeenCalledWith(CONFIG.socketPath);
    expect(deps.createPollingPort).not.toHaveBeenCalled();
    // Subscription observations are not marked with the polled suffix.
    expect(setStatus).toHaveBeenCalledWith("watcher-status", "success:watcher: passed #7 42ms");
  });

  it("does not observe when the project is untrusted", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness();
    ctx.isProjectTrusted = () => false;

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.queryStatus).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("does not observe when on.socket is not configured", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness({
      readConfig: vi.fn().mockResolvedValue(null),
    });

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.queryStatus).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("watcher-status", undefined);
  });

  it("does not observe when there is no UI", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness();
    ctx.hasUI = false;

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.queryStatus).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("falls back to polling when capability negotiation is unavailable at startup", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness({
      loadCapabilities: vi.fn().mockRejectedValue(new Error("socket unavailable")),
      queryStatus: vi.fn().mockRejectedValue(new Error("socket unavailable")),
    });

    await expect(lifecycle.sessionStart({} as never, ctx as never)).resolves.toBeUndefined();

    expect(deps.createPollingPort).toHaveBeenCalledWith(CONFIG.socketPath, CONFIG.pollIntervalMs);
    expect(setStatus).toHaveBeenCalledWith("watcher-status", "warning:watcher: unavailable");
  });

  it("publishes unavailable watcher state when observation fails", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness();
    deps.queryStatus.mockRejectedValueOnce(new Error("socket unavailable"));

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(setStatus).toHaveBeenCalledWith("watcher-status", "warning:watcher: unavailable");
  });

  it("restarting the session keeps exactly one observation active", async () => {
    vi.useFakeTimers();
    const { ctx, deps, lifecycle } = createHarness();

    await lifecycle.sessionStart({} as never, ctx as never);
    await lifecycle.sessionStart({} as never, ctx as never);

    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
    // Session 1: immediate read. Session 2: immediate read + one interval read.
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
    await flush();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "funzzy-failure",
        display: true,
        details: failed,
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    await lifecycle.agentSettled();
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("names the failed task in the watcher_output retrieval hint", async () => {
    const failed: WatcherStatus = {
      ...STATUS,
      state: "failed",
      failures: [
        "run integration @agent-final: Command cargo test has failed with exit status: 101",
      ],
    };
    const { ctx, lifecycle, sendMessage } = createHarness({
      queryStatus: vi.fn().mockResolvedValue(failed),
      readResponder: vi.fn().mockResolvedValue({ mode: "automatic", sessionId: "session-1" }),
    });

    await lifecycle.sessionStart({} as never, ctx as never);
    await flush();

    const message = sendMessage.mock.calls[0]![0] as { content?: string };
    expect(message.content).toContain(
      "next: watcher_output generation=7 task='run integration @agent-final'",
    );
  });

  it("does not deliver when the responder belongs to another session", async () => {
    const failed: WatcherStatus = { ...STATUS, state: "failed", failures: ["boom"] };
    const { ctx, lifecycle, sendMessage } = createHarness({
      queryStatus: vi.fn().mockResolvedValue(failed),
      readResponder: vi.fn().mockResolvedValue({ mode: "pinned", sessionId: "session-2" }),
    });

    await lifecycle.sessionStart({} as never, ctx as never);
    await flush();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not deliver when another session already claimed the failure", async () => {
    const failed: WatcherStatus = { ...STATUS, state: "failed", failures: ["boom"] };
    const { ctx, lifecycle, sendMessage } = createHarness({
      queryStatus: vi.fn().mockResolvedValue(failed),
      readResponder: vi.fn().mockResolvedValue({ mode: "automatic", sessionId: "session-1" }),
      claimFailureDelivery: vi.fn(async () => false),
    });

    await lifecycle.sessionStart({} as never, ctx as never);
    await flush();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not deliver a failure this session already observed through its tools", async () => {
    const failed: WatcherStatus = { ...STATUS, state: "failed", failures: ["boom"] };
    const { ctx, lifecycle, sendMessage } = createHarness({
      queryStatus: vi.fn().mockResolvedValue(failed),
      readResponder: vi.fn().mockResolvedValue({ mode: "automatic", sessionId: "session-1" }),
      isHandledFailure: vi.fn<(sessionId: string, key: string) => boolean>(() => true),
    });

    await lifecycle.sessionStart({} as never, ctx as never);
    await flush();

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("edit correlation checkpoints", () => {
  const editResult = (overrides: Partial<ToolResultEvent> = {}): ToolResultEvent => ({
    type: "tool_result",
    toolCallId: "1",
    toolName: "edit",
    input: { path: "src/index.ts" },
    content: [],
    isError: false,
    ...overrides,
  });

  it("records a checkpoint for a successful edit result", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.toolResult(editResult(), ctx as never);

    expect(deps.recordEditCheckpoint).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ instanceToken: "", paths: ["src/index.ts"] }),
    );
  });

  it("never records a failed edit result", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.toolResult(editResult({ isError: true }), ctx as never);

    expect(deps.recordEditCheckpoint).not.toHaveBeenCalled();
  });

  it("records a successful write result", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.toolResult(
      editResult({ toolName: "write", input: { path: "/project/src/app.ts", content: "x" } }),
      ctx as never,
    );

    expect(deps.recordEditCheckpoint).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ paths: ["src/app.ts"] }),
    );
  });

  it("records a successful write result to a generated path", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.toolResult(
      editResult({ toolName: "write", input: { path: "dist/bundle.js", content: "x" } }),
      ctx as never,
    );

    expect(deps.recordEditCheckpoint).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ paths: ["dist/bundle.js"] }),
    );
  });

  it("keeps checkpoints session-scoped", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    const otherCtx = {
      ...ctx,
      sessionManager: { getSessionId: () => "session-2" },
    };
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.toolResult(editResult(), ctx as never);
    await lifecycle.toolResult(editResult(), otherCtx as never);

    expect(deps.recordEditCheckpoint).toHaveBeenNthCalledWith(1, "session-1", expect.anything());
    expect(deps.recordEditCheckpoint).toHaveBeenNthCalledWith(2, "session-2", expect.anything());
  });

  it("never guesses paths from bash results", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.toolResult(
      editResult({ toolName: "bash", input: { command: "echo hi" } }),
      ctx as never,
    );

    expect(deps.recordEditCheckpoint).not.toHaveBeenCalled();
  });

  it("does not record results without a running watcher", async () => {
    const { ctx, deps, lifecycle } = createHarness();

    await lifecycle.toolResult(editResult(), ctx as never);

    expect(deps.recordEditCheckpoint).not.toHaveBeenCalled();
  });

  it("clears the checkpoint when the watcher instance changed", async () => {
    const changedPort: ObserverPort = {
      async *open() {
        yield {
          sequence: 1,
          status: STATUS,
          source: "subscription",
          freshness: "current",
          snapshot: {
            instance: { token: "fz-9b21", startedAtEpochMs: 0 },
            generation: 7,
            batchId: "b-1",
            state: "passed",
            trigger: null,
            commands: [],
            tasks: [],
            pending: 0,
            freshness: "current",
            durationMs: 42,
            failures: [],
            paths: [],
            configuredConcurrency: 2,
            effectiveConcurrency: 2,
            concurrencySource: "config",
          },
        };
      },
    };
    const { ctx, deps, lifecycle } = createHarness({
      createSubscriptionPort: vi.fn(() => changedPort),
      readEditCheckpoint: vi.fn().mockReturnValue({
        instanceToken: "fz-7f3a",
        paths: ["src/index.ts"],
        at: 1_000,
      }),
    });

    await lifecycle.sessionStart({} as never, ctx as never);
    await flush();

    expect(deps.clearEditCheckpoint).toHaveBeenCalledWith("session-1");
  });

  it("keeps the checkpoint when the watcher instance is unchanged", async () => {
    const { ctx, deps, lifecycle } = createHarness({
      readEditCheckpoint: vi.fn().mockReturnValue({
        instanceToken: "",
        paths: ["src/index.ts"],
        at: 1_000,
      }),
    });

    await lifecycle.sessionStart({} as never, ctx as never);
    await flush();

    expect(deps.clearEditCheckpoint).not.toHaveBeenCalled();
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
  it("does not observe when the session is disconnected", async () => {
    const { ctx, deps, lifecycle, setStatus } = createHarness({
      isSessionDisconnected: vi.fn().mockResolvedValue(true),
    });

    await lifecycle.sessionStart({} as never, ctx as never);

    expect(deps.queryStatus).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("watcher-status", "muted:watcher: disconnected");
  });

  it("stops observing and clears the status bar on disconnect", async () => {
    vi.useFakeTimers();
    const { ctx, deps, lifecycle, setStatus } = createHarness();

    await lifecycle.sessionStart({} as never, ctx as never);
    await lifecycle.disconnect(ctx as never);
    const callsAtDisconnect = deps.queryStatus.mock.calls.length;

    expect(setStatus).toHaveBeenLastCalledWith("watcher-status", undefined);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.queryStatus.mock.calls.length).toBe(callsAtDisconnect);
  });

  it("invalidates capability negotiation on disconnect", async () => {
    const { ctx, deps, lifecycle } = createHarness();

    await lifecycle.sessionStart({} as never, ctx as never);
    await lifecycle.disconnect(ctx as never);

    expect(deps.invalidateCapabilities).toHaveBeenCalled();
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

  it("connect resumes observing after disconnect", async () => {
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
    expect(setStatus).toHaveBeenLastCalledWith(
      "watcher-status",
      "success:watcher: passed #7 42ms (polled)",
    );
  });

  it("does not deliver new failures after disconnect", async () => {
    const failed: WatcherStatus = { ...STATUS, state: "failed", failures: ["boom"] };
    const { ctx, lifecycle, sendMessage } = createHarness({
      queryStatus: vi.fn().mockResolvedValue(failed),
      readResponder: vi.fn().mockResolvedValue({ mode: "automatic", sessionId: "session-1" }),
    });

    await lifecycle.sessionStart({} as never, ctx as never);
    await flush();
    const callsAtDisconnect = sendMessage.mock.calls.length;
    await lifecycle.disconnect(ctx as never);
    await lifecycle.agentSettled();
    await flush();

    expect(sendMessage.mock.calls.length).toBe(callsAtDisconnect);
  });
});

describe("session shutdown", () => {
  it("stops observing, clears the status bar, and is idempotent", async () => {
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
  it("does not trigger additional reads (push-driven)", async () => {
    const { ctx, deps, lifecycle } = createHarness();
    await lifecycle.sessionStart({} as never, ctx as never);

    await lifecycle.agentSettled();

    expect(deps.queryStatus).toHaveBeenCalledTimes(1);
  });
});
