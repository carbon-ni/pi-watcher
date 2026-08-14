import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import funzzyStatus from "./index.js";

const {
  queryStatus,
  status,
  formatStatus,
  listTargets,
  requestRun,
  readResponder,
  setPinnedResponder,
  clearPinnedResponder,
  recordAutomaticResponder,
  disconnectSession,
  connectSession,
} = vi.hoisted(() => {
  const status = {
    generation: 7,
    state: "passed" as const,
    trigger: "src/index.ts",
    commands: ["make all"],
    durationMs: 42,
    failures: [] as string[],
  };
  return {
    queryStatus: vi.fn(),
    status,
    formatStatus: vi.fn(),
    listTargets: vi.fn(),
    requestRun: vi.fn(),
    readResponder: vi.fn(),
    setPinnedResponder: vi.fn(),
    clearPinnedResponder: vi.fn(),
    recordAutomaticResponder: vi.fn(),
    disconnectSession: vi.fn(),
    connectSession: vi.fn(),
  };
});

vi.mock("./infra/config.js", () => ({
  readConfig: vi.fn().mockResolvedValue({ socketPath: "/tmp/funzzy.sock", pollIntervalMs: 1_000 }),
}));
vi.mock("./infra/client.js", () => ({
  formatStatus,
  listTargets,
  queryStatus,
  requestRun,
  requestRunAtomic: vi.fn(),
  FunzzyRpcError: class FunzzyRpcError extends Error {},
  FunzzyRequestTimeoutError: class FunzzyRequestTimeoutError extends Error {},
  FunzzyDisconnectError: class FunzzyDisconnectError extends Error {},
  queryCapabilities: vi.fn(),
}));
vi.mock("./infra/capabilities.js", () => ({
  CapabilityCache: class CapabilityCache {
    invalidate(): void {}
  },
  loadCapabilities: vi.fn().mockResolvedValue({
    source: "legacy",
    protocolVersion: "1.0",
    schemaVersion: 1,
    instance: { token: "", startedAtEpochMs: null },
    methods: ["status", "targets", "run"],
    optionalFields: [],
    limits: { outputRetentionBytes: 0, maxResponseBytes: 65536, maxEvidenceLines: 40 },
    features: {
      atomicAwait: false,
      subscription: false,
      correlatedSnapshots: false,
      outputRetrieval: false,
      pendingWork: false,
    },
  }),
}));
vi.mock("./infra/ownership.js", () => ({
  clearPinnedResponder,
  readResponder,
  recordAutomaticResponder,
  setPinnedResponder,
}));
vi.mock("./infra/membership.js", () => ({
  connectSession,
  disconnectSession,
  isSessionDisconnected: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  queryStatus.mockReset().mockResolvedValue(status);
  formatStatus.mockReset().mockReturnValue("PASS gen=7");
  listTargets.mockReset().mockResolvedValue([{ name: "lint", commands: ["npm run lint"] }]);
  requestRun.mockReset().mockResolvedValue(10);
  readResponder.mockReset().mockResolvedValue(null);
  setPinnedResponder.mockReset().mockResolvedValue(undefined);
  clearPinnedResponder.mockReset().mockResolvedValue(undefined);
  recordAutomaticResponder.mockReset().mockResolvedValue(undefined);
  disconnectSession.mockReset().mockResolvedValue(undefined);
  connectSession.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function createStatusHarness() {
  vi.useFakeTimers();
  const handlers = new Map<string, (...args: never[]) => Promise<void>>();
  const setStatus = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (...args: never[]) => Promise<void>) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
  };
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

  funzzyStatus(pi as never);
  return { ctx, handlers, setStatus };
}

function createCommandHarness() {
  const handlers = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const completions = new Map<string, (prefix: string) => unknown>();
  const notify = vi.fn();
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(
      (
        name: string,
        options: {
          handler: (args: string, ctx: never) => Promise<void>;
          getArgumentCompletions?: (prefix: string) => unknown;
        },
      ) => {
        handlers.set(name, options.handler);
        if (options.getArgumentCompletions) completions.set(name, options.getArgumentCompletions);
      },
    ),
  };
  const ctx = {
    cwd: "/project",
    isProjectTrusted: () => true,
    ui: { notify },
    sessionManager: { getSessionId: () => "session-1" },
  };

  funzzyStatus(pi as never);
  return { ctx, handlers, notify, completions };
}

describe("funzzyStatus registration", () => {
  it("registers watcher-prefixed tools", () => {
    const tools: string[] = [];
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn(),
    };

    funzzyStatus(pi as never);

    expect(tools).toEqual([
      "watcher_status",
      "watcher_targets",
      "watcher_observe",
      "watcher_output",
      "watcher_cancel",
      "watcher_verify",
    ]);
    expect(tools).not.toContain("funzzy_status");
    expect(tools).not.toContain("funzzy_targets");
    expect(tools).not.toContain("funzzy_verify");
  });

  it("registers watcher-prefixed slash commands", () => {
    const commands: string[] = [];
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string) => commands.push(name)),
    };

    funzzyStatus(pi as never);

    expect(commands).toEqual([
      "watcher-targets",
      "watcher-responder",
      "watcher-status",
      "watcher-disconnect",
      "watcher-connect",
    ]);
  });

  it("does not preserve deprecated funzzy-prefixed slash commands", () => {
    const commands: string[] = [];
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string) => commands.push(name)),
    };

    funzzyStatus(pi as never);

    expect(commands).not.toContain("funzzy-targets");
    expect(commands).not.toContain("funzzy-responder");
    expect(commands).not.toContain("funzzy-status");
  });

  it("publishes watcher state through Pi's status bar", async () => {
    const { ctx, handlers, setStatus } = createStatusHarness();

    await handlers.get("session_start")?.({} as never, ctx as never);

    expect(setStatus).toHaveBeenCalledWith(
      "watcher-status",
      "success:watcher: passed #7 42ms (polled)",
    );

    await handlers.get("session_shutdown")?.({} as never, ctx as never);
    expect(setStatus).toHaveBeenLastCalledWith("watcher-status", undefined);
  });

  it("publishes unavailable watcher state through Pi's status bar", async () => {
    queryStatus.mockRejectedValueOnce(new Error("socket unavailable"));
    const { ctx, handlers, setStatus } = createStatusHarness();

    await handlers.get("session_start")?.({} as never, ctx as never);

    expect(setStatus).toHaveBeenCalledWith("watcher-status", "warning:watcher: unavailable");
  });
});

describe("watcher-status command", () => {
  it("notifies the formatted status", async () => {
    const { ctx, handlers, notify } = createCommandHarness();

    await handlers.get("watcher-status")?.("", ctx as never);

    expect(notify).toHaveBeenCalledWith("PASS gen=7", "info");
  });

  it("warns when the project is untrusted", async () => {
    const { ctx, handlers, notify } = createCommandHarness();
    ctx.isProjectTrusted = () => false;

    await handlers.get("watcher-status")?.("", ctx as never);

    expect(notify).toHaveBeenCalledWith("Funzzy project configuration is not trusted", "warning");
  });

  it("notifies real errors instead of hiding them", async () => {
    const { ctx, handlers, notify } = createCommandHarness();
    queryStatus.mockRejectedValueOnce(new Error("socket down"));

    await handlers.get("watcher-status")?.("", ctx as never);

    expect(notify).toHaveBeenCalledWith("socket down", "error");
  });
});

describe("watcher-targets command", () => {
  it("notifies formatted targets", async () => {
    const { ctx, handlers, notify } = createCommandHarness();

    await handlers.get("watcher-targets")?.("", ctx as never);

    expect(notify).toHaveBeenCalledWith("- lint: npm run lint", "info");
  });

  it("notifies errors from the control socket", async () => {
    const { ctx, handlers, notify } = createCommandHarness();
    listTargets.mockRejectedValueOnce(new Error("socket down"));

    await handlers.get("watcher-targets")?.("", ctx as never);

    expect(notify).toHaveBeenCalledWith("socket down", "error");
  });
});

describe("watcher-responder command", () => {
  it("pins the responder to the current session on claim", async () => {
    const { ctx, handlers, notify } = createCommandHarness();

    await handlers.get("watcher-responder")?.("claim", ctx as never);

    expect(setPinnedResponder).toHaveBeenCalledWith("/tmp/funzzy.sock", "session-1");
    expect(notify).toHaveBeenCalledWith(
      "Funzzy responder pinned to this Pi session (session-1)",
      "info",
    );
  });

  it("returns the responder to automatic tracking on auto", async () => {
    const { ctx, handlers, notify } = createCommandHarness();

    await handlers.get("watcher-responder")?.("auto", ctx as never);

    expect(clearPinnedResponder).toHaveBeenCalledWith("/tmp/funzzy.sock");
    expect(recordAutomaticResponder).toHaveBeenCalledWith("/tmp/funzzy.sock", "session-1");
    expect(notify).toHaveBeenCalledWith(
      "Funzzy responder returned to automatic activity tracking",
      "info",
    );
  });

  it("reports the current responder on status", async () => {
    const { ctx, handlers, notify } = createCommandHarness();

    await handlers.get("watcher-responder")?.("", ctx as never);
    expect(notify).toHaveBeenCalledWith("Funzzy responder: none", "info");

    readResponder.mockResolvedValue({ mode: "automatic", sessionId: "session-1" });
    await handlers.get("watcher-responder")?.("status", ctx as never);
    expect(notify).toHaveBeenLastCalledWith("Funzzy responder: automatic session-1", "info");
  });

  it("warns on an unknown action", async () => {
    const { ctx, handlers, notify } = createCommandHarness();

    await handlers.get("watcher-responder")?.("explode", ctx as never);

    expect(notify).toHaveBeenCalledWith("Usage: /watcher-responder [status|claim|auto]", "warning");
  });

  it("notifies errors from responder operations", async () => {
    const { ctx, handlers, notify } = createCommandHarness();
    setPinnedResponder.mockRejectedValueOnce(new Error("permission denied"));

    await handlers.get("watcher-responder")?.("claim", ctx as never);

    expect(notify).toHaveBeenCalledWith("permission denied", "error");
  });

  it("offers responder actions as argument completions", () => {
    const { completions } = createCommandHarness();
    const complete = completions.get("watcher-responder")!;

    expect(complete("")).toEqual([
      { value: "status", label: "status" },
      { value: "claim", label: "claim" },
      { value: "auto", label: "auto" },
    ]);
    expect(complete("c")).toEqual([{ value: "claim", label: "claim" }]);
    expect(complete("x")).toBeNull();
  });
});

describe("watcher-disconnect command", () => {
  it("persists the disconnect for this session and notifies", async () => {
    const { ctx, handlers, notify } = createCommandHarness();

    await handlers.get("watcher-disconnect")?.("", ctx as never);

    expect(disconnectSession).toHaveBeenCalledWith("/tmp/funzzy.sock", "session-1");
    expect(notify).toHaveBeenCalledWith("Watcher disconnected for this session", "info");
  });

  it("releases a pinned responder held by this session", async () => {
    readResponder.mockResolvedValue({ mode: "pinned", sessionId: "session-1" });
    const { ctx, handlers } = createCommandHarness();

    await handlers.get("watcher-disconnect")?.("", ctx as never);

    expect(clearPinnedResponder).toHaveBeenCalledWith("/tmp/funzzy.sock");
  });

  it("keeps a pinned responder held by another session", async () => {
    readResponder.mockResolvedValue({ mode: "pinned", sessionId: "session-2" });
    const { ctx, handlers } = createCommandHarness();

    await handlers.get("watcher-disconnect")?.("", ctx as never);

    expect(clearPinnedResponder).not.toHaveBeenCalled();
  });

  it("warns when the project is untrusted", async () => {
    const { ctx, handlers, notify } = createCommandHarness();
    ctx.isProjectTrusted = () => false;

    await handlers.get("watcher-disconnect")?.("", ctx as never);

    expect(notify).toHaveBeenCalledWith("Funzzy project configuration is not trusted", "warning");
    expect(disconnectSession).not.toHaveBeenCalled();
  });

  it("notifies errors from the disconnect operation", async () => {
    disconnectSession.mockRejectedValueOnce(new Error("permission denied"));
    const { ctx, handlers, notify } = createCommandHarness();

    await handlers.get("watcher-disconnect")?.("", ctx as never);

    expect(notify).toHaveBeenCalledWith("permission denied", "error");
  });
});

describe("watcher-connect command", () => {
  it("persists the reconnect for this session and notifies", async () => {
    const { ctx, handlers, notify } = createCommandHarness();

    await handlers.get("watcher-connect")?.("", ctx as never);

    expect(connectSession).toHaveBeenCalledWith("/tmp/funzzy.sock", "session-1");
    expect(notify).toHaveBeenCalledWith("Watcher reconnected for this session", "info");
  });

  it("warns when the project is untrusted", async () => {
    const { ctx, handlers, notify } = createCommandHarness();
    ctx.isProjectTrusted = () => false;

    await handlers.get("watcher-connect")?.("", ctx as never);

    expect(notify).toHaveBeenCalledWith("Funzzy project configuration is not trusted", "warning");
    expect(connectSession).not.toHaveBeenCalled();
  });

  it("notifies errors from the connect operation", async () => {
    connectSession.mockRejectedValueOnce(new Error("permission denied"));
    const { ctx, handlers, notify } = createCommandHarness();

    await handlers.get("watcher-connect")?.("", ctx as never);

    expect(notify).toHaveBeenCalledWith("permission denied", "error");
  });
});
