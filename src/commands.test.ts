import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import funzzyStatus from "./index.js";

const { queryStatus, status } = vi.hoisted(() => ({
  queryStatus: vi.fn(),
  status: {
    generation: 7,
    state: "passed" as const,
    trigger: "src/index.ts",
    commands: ["make all"],
    durationMs: 42,
    failures: [],
  },
}));

vi.mock("./infra/config.js", () => ({
  readConfig: vi.fn().mockResolvedValue({ socketPath: "/tmp/funzzy.sock", pollIntervalMs: 1_000 }),
}));
vi.mock("./infra/client.js", () => ({
  formatStatus: vi.fn(),
  listTargets: vi.fn(),
  queryStatus,
  requestRun: vi.fn(),
}));
vi.mock("./infra/ownership.js", () => ({
  clearPinnedResponder: vi.fn(),
  readResponder: vi.fn().mockResolvedValue(null),
  recordAutomaticResponder: vi.fn(),
  setPinnedResponder: vi.fn(),
}));

beforeEach(() => {
  queryStatus.mockResolvedValue(status);
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

describe("funzzyStatus registration", () => {
  it("registers watcher-prefixed tools", () => {
    const tools: string[] = [];
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn(),
    };

    funzzyStatus(pi as never);

    expect(tools).toEqual(["watcher_status", "watcher_targets", "watcher_verify"]);
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

    expect(commands).toEqual(["watcher-targets", "watcher-responder", "watcher-status"]);
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

    expect(setStatus).toHaveBeenCalledWith("watcher-status", "success:watcher: passed #7 42ms");

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
