import { afterEach, describe, expect, it, vi } from "vitest";

import { registerTools } from "./tools.js";
import { createRequireTrustedConfig } from "./trusted-config.js";
import { formatStatus } from "./infra/client.js";
import { formatTargets } from "./domain/targets-presentation.js";
import type { WatcherVerification } from "./domain/verification.js";
import type { WatcherObservationResult } from "./domain/observation-result.js";
import type { WatcherObservation } from "./domain/observation.js";
import type { WatcherOutputResult } from "./domain/output.js";
import type { WatcherCancelResult } from "./domain/cancel.js";
import { failureEngagementKeyParts } from "./domain/failure-notifier.js";
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
  correlation: "unknown",
};

const OUTPUT_RESULT: WatcherOutputResult = {
  generation: 7,
  task: "lint",
  stream: "stdout",
  observedBytes: 8192,
  retainedBytes: 4096,
  evicted: false,
  truncated: false,
  lines: ["line one", "line two"],
};

type RegisteredToolCapture = {
  name: string;
  description: string;
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
    evidenceTruncated: false,
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
    requestOutput: vi.fn().mockResolvedValue(OUTPUT_RESULT),
    cancelGeneration: vi
      .fn()
      .mockResolvedValue({ outcome: "cancelled", generation: 7, message: null }),
    recordHandledFailure: vi.fn(),
    readEditCheckpoint: vi.fn().mockReturnValue(null),
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

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("registerTools", () => {
  it("registers the four watcher-prefixed tools", () => {
    const { pi, tools } = createPi();

    registerTools(pi as never, createDeps());

    expect(tools.map((tool) => tool.name)).toEqual([
      "watcher_status",
      "watcher_targets",
      "watcher_observe",
      "watcher_output",
      "watcher_cancel",
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

  it("passes the session checkpoint and project root for batch correlation", async () => {
    const { pi, tools } = createPi();
    const requestObservation = vi.fn().mockResolvedValue({
      ...OBSERVE_RESULT,
      correlation: "exact-overlap",
    });
    const checkpoint = {
      instanceToken: "fz-7f3a",
      paths: ["src/index.ts"],
      at: 1_000,
    };
    const readEditCheckpoint = vi.fn().mockReturnValue(checkpoint);
    registerTools(pi as never, createDeps({ requestObservation, readEditCheckpoint }));

    const result = await runTool(
      registeredTool(tools, "watcher_observe"),
      { wait: true },
      trustedCtx(),
    );

    expect(readEditCheckpoint).toHaveBeenCalledWith("session-1");
    expect(requestObservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ checkpoint, projectRoot: "/project" }),
    );
    expect(result.details).toMatchObject({ correlation: "exact-overlap" });
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

describe("watcher_output", () => {
  it("retrieves bounded output for an exact generation with typed details", async () => {
    const { pi, tools } = createPi();
    registerTools(pi as never, createDeps());

    const result = await runTool(
      registeredTool(tools, "watcher_output"),
      { generation: 7 },
      trustedCtx(),
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "OUTPUT gen=7 task=lint stream=stdout retained=4096 observed=8192\n  line one\n  line two",
        },
      ],
      details: OUTPUT_RESULT,
    });
  });

  it("passes task, stream, tail, and full through to the client", async () => {
    const { pi, tools } = createPi();
    const requestOutput = vi.fn().mockResolvedValue(OUTPUT_RESULT);
    registerTools(pi as never, createDeps({ requestOutput }));

    await runTool(
      registeredTool(tools, "watcher_output"),
      { generation: 7, task: "lint", stream: "stderr", tail: 5, full: true },
      trustedCtx(),
    );

    expect(requestOutput).toHaveBeenCalledWith(
      CONFIG.socketPath,
      { generation: 7, task: "lint", stream: "stderr", tail: 5, full: true },
      undefined,
    );
  });

  it("renders whole-generation identity as task=all stream=all", async () => {
    const { pi, tools } = createPi();
    const requestOutput = vi
      .fn()
      .mockResolvedValue({ ...OUTPUT_RESULT, task: null, stream: null, lines: [] });
    registerTools(pi as never, createDeps({ requestOutput }));

    const result = await runTool(
      registeredTool(tools, "watcher_output"),
      { generation: 7 },
      trustedCtx(),
    );

    expect(result.content[0]!.text).toBe(
      "OUTPUT gen=7 task=all stream=all retained=4096 observed=8192",
    );
  });

  it("labels eviction and truncation in the text", async () => {
    const { pi, tools } = createPi();
    const requestOutput = vi
      .fn()
      .mockResolvedValue({ ...OUTPUT_RESULT, evicted: true, retainedBytes: 0, lines: [] });
    registerTools(pi as never, createDeps({ requestOutput }));

    const result = await runTool(
      registeredTool(tools, "watcher_output"),
      { generation: 7 },
      trustedCtx(),
    );

    expect(result.content[0]!.text).toContain(" evicted");
  });

  it("propagates actionable retrieval errors", async () => {
    const { pi, tools } = createPi();
    const requestOutput = vi
      .fn()
      .mockRejectedValue(new Error("Funzzy output for generation 99 is not available"));
    registerTools(pi as never, createDeps({ requestOutput }));

    await expect(
      runTool(registeredTool(tools, "watcher_output"), { generation: 99 }, trustedCtx()),
    ).rejects.toThrow("Funzzy output for generation 99 is not available");
  });

  it("describes itself as retrieval, not a status call", () => {
    const { pi, tools } = createPi();
    registerTools(pi as never, createDeps());

    const tool = registeredTool(tools, "watcher_output");
    expect(tool!.description).toMatch(/not a status call/);
  });
});

describe("handled failure recording", () => {
  it("records a failed verification so the follow-up is not redundant", async () => {
    const { pi, tools } = createPi();
    const recordHandledFailure = vi.fn();
    const verifyRequest = vi.fn().mockResolvedValue({
      reason: "failed",
      target: "lint",
      generation: 7,
      instance: null,
      failures: ["boom"],
      fingerprint: "abc123",
      evidenceTruncated: false,
    });
    registerTools(pi as never, createDeps({ verifyRequest, recordHandledFailure }));

    await expect(
      runTool(registeredTool(tools, "watcher_verify"), { target: "lint" }, trustedCtx()),
    ).rejects.toThrow(/FAIL/);

    expect(recordHandledFailure).toHaveBeenCalledWith(
      "session-1",
      failureEngagementKeyParts(null, 7),
    );
  });

  it("records the instance-scoped engagement key from a failed verification", async () => {
    const { pi, tools } = createPi();
    const recordHandledFailure = vi.fn();
    const verifyRequest = vi.fn().mockResolvedValue({
      reason: "failed",
      target: "lint",
      generation: 7,
      instance: { token: "fz-7f3a", startedAtEpochMs: 0 },
      failures: ["boom"],
      fingerprint: "abc123",
      evidenceTruncated: false,
    });
    registerTools(pi as never, createDeps({ verifyRequest, recordHandledFailure }));

    await expect(
      runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx()),
    ).rejects.toThrow(/FAIL/);

    expect(recordHandledFailure).toHaveBeenCalledWith("session-1", "fz-7f3a:7");
  });

  it("does not record passed or unknown verifications", async () => {
    const { pi, tools } = createPi();
    const recordHandledFailure = vi.fn();
    registerTools(pi as never, createDeps({ recordHandledFailure }));

    await runTool(registeredTool(tools, "watcher_verify"), {}, trustedCtx());

    expect(recordHandledFailure).not.toHaveBeenCalled();
  });

  it("records a failed terminal observation so the follow-up is not redundant", async () => {
    const { pi, tools } = createPi();
    const recordHandledFailure = vi.fn();
    const requestObservation = vi.fn().mockResolvedValue({
      outcome: "terminal",
      instance: { token: "fz-7f3a", startedAtEpochMs: 0 },
      generation: 7,
      state: "failed",
      tasks: [],
      failures: ["boom"],
      truncated: false,
    });
    registerTools(pi as never, createDeps({ requestObservation, recordHandledFailure }));

    await runTool(registeredTool(tools, "watcher_observe"), {}, trustedCtx());

    expect(recordHandledFailure).toHaveBeenCalledWith("session-1", "fz-7f3a:7");
  });

  it("does not record a passed observation or non-terminal outcomes", async () => {
    const { pi, tools } = createPi();
    const recordHandledFailure = vi.fn();
    registerTools(pi as never, createDeps({ recordHandledFailure }));

    await runTool(registeredTool(tools, "watcher_observe"), {}, trustedCtx());

    expect(recordHandledFailure).not.toHaveBeenCalled();
  });
});

describe("watcher_cancel", () => {
  it("cancels the exact generation with a bounded acknowledgement wait", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi
      .fn()
      .mockResolvedValue({ outcome: "cancelled", generation: 7, message: null });
    registerTools(pi as never, createDeps({ cancelGeneration }));

    const result = await runTool(
      registeredTool(tools, "watcher_cancel"),
      { generation: 7, timeoutSeconds: 5 },
      trustedCtx(),
    );

    expect(cancelGeneration).toHaveBeenCalledWith(CONFIG, 7, 5_000);
    expect(result.content[0]!.text).toBe("CANCEL gen=7 cancelled");
    expect(result.details).toEqual({ outcome: "cancelled", generation: 7, message: null });
  });

  it("defaults the acknowledgement wait", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi
      .fn()
      .mockResolvedValue({ outcome: "not-running", generation: 7, message: null });
    registerTools(pi as never, createDeps({ cancelGeneration }));

    await runTool(registeredTool(tools, "watcher_cancel"), { generation: 7 }, trustedCtx());

    expect(cancelGeneration).toHaveBeenCalledWith(CONFIG, 7, 3_000);
  });

  it("reports escalated cleanup without hiding the outcome", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi
      .fn()
      .mockResolvedValue({ outcome: "escalated", generation: 7, message: null });
    registerTools(pi as never, createDeps({ cancelGeneration }));

    const result = await runTool(
      registeredTool(tools, "watcher_cancel"),
      { generation: 7 },
      trustedCtx(),
    );

    expect(result.content[0]!.text).toBe("CANCEL gen=7 escalated");
  });
});

describe("watcher_verify cancellation effect", () => {
  function abortedVerification(generation = 7) {
    return {
      reason: "aborted" as const,
      target: "lint",
      generation,
      fingerprint: "abc123",
      failures: [],
    };
  }

  it("sends compare-and-cancel for the exact generation when abort fires during the run", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi
      .fn()
      .mockResolvedValue({ outcome: "cancelled", generation: 7, message: null });
    const controller = new AbortController();
    const verifyRequest = vi.fn(
      async (
        _config: unknown,
        _request: unknown,
        _fingerprint: unknown,
        _signal: unknown,
        onGeneration: ((generation: number) => void) | undefined,
      ) => {
        onGeneration?.(7);
        controller.abort();
        return abortedVerification();
      },
    );
    registerTools(pi as never, createDeps({ verifyRequest, cancelGeneration }));
    const tool = registeredTool(tools, "watcher_verify")!;

    await expect(tool.execute("1", {}, controller.signal, undefined, trustedCtx())).rejects.toThrow(
      "ABORTED gen=7 target=lint cleanup=cancelled",
    );
    expect(cancelGeneration).toHaveBeenCalledWith(CONFIG, 7, 3_000);
  });

  it("cancels even when abort lands between schedule and generation recording", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi
      .fn()
      .mockResolvedValue({ outcome: "cancelled", generation: 7, message: null });
    const controller = new AbortController();
    const verifyRequest = vi.fn(
      async (
        _config: unknown,
        _request: unknown,
        _fingerprint: unknown,
        _signal: unknown,
        onGeneration: ((generation: number) => void) | undefined,
      ) => {
        controller.abort();
        onGeneration?.(7);
        return abortedVerification();
      },
    );
    registerTools(pi as never, createDeps({ verifyRequest, cancelGeneration }));
    const tool = registeredTool(tools, "watcher_verify")!;

    await expect(tool.execute("1", {}, controller.signal, undefined, trustedCtx())).rejects.toThrow(
      "ABORTED gen=7 target=lint cleanup=cancelled",
    );
    expect(cancelGeneration).toHaveBeenCalledWith(CONFIG, 7, 3_000);
  });

  it("never cancels when abort fires before any generation is recorded", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const verifyRequest = vi.fn().mockResolvedValue(abortedVerification());
    registerTools(pi as never, createDeps({ verifyRequest, cancelGeneration }));
    const tool = registeredTool(tools, "watcher_verify")!;

    await expect(tool.execute("1", {}, controller.signal, undefined, trustedCtx())).rejects.toThrow(
      "ABORTED gen=7 target=lint cleanup=none",
    );
    expect(cancelGeneration).not.toHaveBeenCalled();
  });

  it("leaves replacement work untouched when the recorded generation was superseded", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi
      .fn()
      .mockResolvedValue({ outcome: "not-running", generation: 7, message: null });
    const controller = new AbortController();
    const verifyRequest = vi.fn(
      async (
        _config: unknown,
        _request: unknown,
        _fingerprint: unknown,
        _signal: unknown,
        onGeneration: ((generation: number) => void) | undefined,
      ) => {
        onGeneration?.(7);
        controller.abort();
        return abortedVerification();
      },
    );
    registerTools(pi as never, createDeps({ verifyRequest, cancelGeneration }));
    const tool = registeredTool(tools, "watcher_verify")!;

    await expect(tool.execute("1", {}, controller.signal, undefined, trustedCtx())).rejects.toThrow(
      "ABORTED gen=7 target=lint cleanup=none",
    );
    expect(cancelGeneration).toHaveBeenCalledWith(CONFIG, 7, 3_000);
  });

  it("reports escalated cleanup from the server", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi
      .fn()
      .mockResolvedValue({ outcome: "escalated", generation: 7, message: null });
    const controller = new AbortController();
    const verifyRequest = vi.fn(
      async (
        _config: unknown,
        _request: unknown,
        _fingerprint: unknown,
        _signal: unknown,
        onGeneration: ((generation: number) => void) | undefined,
      ) => {
        onGeneration?.(7);
        controller.abort();
        return abortedVerification();
      },
    );
    registerTools(pi as never, createDeps({ verifyRequest, cancelGeneration }));
    const tool = registeredTool(tools, "watcher_verify")!;

    await expect(tool.execute("1", {}, controller.signal, undefined, trustedCtx())).rejects.toThrow(
      "ABORTED gen=7 target=lint cleanup=escalated",
    );
  });

  it("reports unknown cleanup when the acknowledgement cannot be confirmed", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi
      .fn()
      .mockResolvedValue({ outcome: "unknown", generation: 7, message: "socket gone" });
    const controller = new AbortController();
    const verifyRequest = vi.fn(
      async (
        _config: unknown,
        _request: unknown,
        _fingerprint: unknown,
        _signal: unknown,
        onGeneration: ((generation: number) => void) | undefined,
      ) => {
        onGeneration?.(7);
        controller.abort();
        return abortedVerification();
      },
    );
    registerTools(pi as never, createDeps({ verifyRequest, cancelGeneration }));
    const tool = registeredTool(tools, "watcher_verify")!;

    await expect(tool.execute("1", {}, controller.signal, undefined, trustedCtx())).rejects.toThrow(
      "ABORTED gen=7 target=lint cleanup=unknown",
    );
  });

  it("waits for the bounded acknowledgement before returning", async () => {
    const { pi, tools } = createPi();
    let resolveCancel: ((result: WatcherCancelResult) => void) | null = null;
    const cancelGeneration = vi
      .fn()
      .mockImplementation(
        () => new Promise<WatcherCancelResult>((resolve) => (resolveCancel = resolve)),
      );
    const controller = new AbortController();
    const verifyRequest = vi.fn(
      async (
        _config: unknown,
        _request: unknown,
        _fingerprint: unknown,
        _signal: unknown,
        onGeneration: ((generation: number) => void) | undefined,
      ) => {
        onGeneration?.(7);
        controller.abort();
        return abortedVerification();
      },
    );
    registerTools(pi as never, createDeps({ verifyRequest, cancelGeneration }));
    const tool = registeredTool(tools, "watcher_verify")!;

    const pending = tool.execute("1", {}, controller.signal, undefined, trustedCtx());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const releaseCancel = (result: WatcherCancelResult): void => {
      if (resolveCancel !== null) resolveCancel(result);
    };
    releaseCancel({ outcome: "cancelled", generation: 7, message: null });

    await expect(pending).rejects.toThrow("ABORTED gen=7 target=lint cleanup=cancelled");
  });

  it("ignores repeated aborts without double-cancelling", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi
      .fn()
      .mockResolvedValue({ outcome: "cancelled", generation: 7, message: null });
    const controller = new AbortController();
    const verifyRequest = vi.fn(
      async (
        _config: unknown,
        _request: unknown,
        _fingerprint: unknown,
        _signal: unknown,
        onGeneration: ((generation: number) => void) | undefined,
      ) => {
        onGeneration?.(7);
        controller.abort();
        controller.abort();
        return abortedVerification();
      },
    );
    registerTools(pi as never, createDeps({ verifyRequest, cancelGeneration }));
    const tool = registeredTool(tools, "watcher_verify")!;

    await expect(tool.execute("1", {}, controller.signal, undefined, trustedCtx())).rejects.toThrow(
      /cleanup=cancelled/,
    );
    expect(cancelGeneration).toHaveBeenCalledTimes(1);
  });

  it("never sends a cancel on a clean run", async () => {
    const { pi, tools } = createPi();
    const cancelGeneration = vi.fn();
    const controller = new AbortController();
    registerTools(pi as never, createDeps({ cancelGeneration }));
    const tool = registeredTool(tools, "watcher_verify")!;

    const result = (await tool.execute(
      "1",
      {},
      controller.signal,
      undefined,
      trustedCtx(),
    )) as ToolResult;

    expect(result.content[0]!.text).toBe("PASS gen=7 target=lint duration=42ms fingerprint=abc123");
    expect(cancelGeneration).not.toHaveBeenCalled();
    controller.abort();
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
      expect.any(Function),
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
