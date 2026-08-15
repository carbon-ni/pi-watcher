import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestVerifiedRun, type AtomicRunOutcome, type VerifyPort } from "./verify.js";
import type { WatcherCorrelatedSnapshot } from "../domain/capabilities.js";
import type { WatcherStatus } from "../domain/watcher.js";

const SNAPSHOT: WatcherCorrelatedSnapshot = {
  instance: { token: "fz-7f3a", startedAtEpochMs: 1710000000000 },
  generation: 7,
  batchId: "b-21",
  state: "passed",
  trigger: "control:lint",
  commands: ["make all"],
  tasks: [{ id: "t-2", name: "lint", state: "passed", durationMs: 42 }],
  pending: 0,
  freshness: "current",
  durationMs: 42,
  failures: [],
  paths: [],
  configuredConcurrency: 2,
  effectiveConcurrency: 2,
  concurrencySource: "config",
};

const STATUS: WatcherStatus = {
  generation: 7,
  state: "passed",
  trigger: "control:lint",
  commands: ["make all"],
  durationMs: 42,
  failures: [],
};

function terminal(outcome: Partial<Extract<AtomicRunOutcome, { kind: "terminal" }>> = {}) {
  return {
    kind: "terminal" as const,
    generation: 7,
    status: STATUS,
    snapshot: SNAPSHOT,
    source: "subscription" as const,
    ...outcome,
  };
}

function createFakePort(outcomes: AtomicRunOutcome[] = []) {
  const calls: Array<{ target: string; timeoutMs: number }> = [];
  const port: VerifyPort = {
    async runAndAwait(request) {
      calls.push({ target: request.target, timeoutMs: request.timeoutMs });
      const outcome = outcomes.shift();
      if (outcome === undefined) throw new Error("no more scripted outcomes");
      return outcome;
    },
  };
  return { port, calls };
}

const fingerprint = vi.fn().mockResolvedValue("abc123");

beforeEach(() => {
  fingerprint.mockReset().mockResolvedValue("abc123");
});

describe("evidence bounding", () => {
  it("flags truncated evidence when the failure tail is cut", async () => {
    const manyFailures = Array.from({ length: 50 }, (_, index) => `failure ${index}`);
    const { port } = createFakePort([
      terminal({
        snapshot: { ...SNAPSHOT, state: "failed", failures: manyFailures },
        status: { ...STATUS, state: "failed", failures: manyFailures },
      }),
    ]);

    const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

    expect(result.reason).toBe("failed");
    expect(result.failures).toHaveLength(40);
    expect(result.evidenceTruncated).toBe(true);
  });

  it("keeps complete evidence untruncated", async () => {
    const { port } = createFakePort([
      terminal({
        snapshot: { ...SNAPSHOT, state: "failed", failures: ["boom"] },
        status: { ...STATUS, state: "failed", failures: ["boom"] },
      }),
    ]);

    const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

    expect(result.reason).toBe("failed");
    expect(result.evidenceTruncated).toBe(false);
  });
});

describe("verification progress", () => {
  it("reports truthful elapsed history when the generation is scheduled", async () => {
    const progress: Array<{ generation: number; timeoutMs: number; timeoutSource: string }> = [];
    const port: VerifyPort = {
      async runAndAwait(request) {
        request.onSchedule?.(7);
        return terminal();
      },
    };

    await requestVerifiedRun(
      {
        target: "lint",
        timeoutMs: 95_000,
        timeoutSource: "measured",
        estimate: {
          typicalMs: 38_000,
          upperMs: 61_000,
          recommendedTimeoutMs: 95_000,
          samples: 12,
          confidence: "high",
          source: "measured",
        },
      },
      { port, fingerprint, onProgress: (entry) => progress.push(entry) },
    );

    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      generation: 7,
      timeoutMs: 95_000,
      timeoutSource: "measured",
    });
  });
});

describe("generation reporting", () => {
  it("bridges the scheduled generation to the caller as soon as it is known", async () => {
    const generations: number[] = [];
    const port: VerifyPort = {
      async runAndAwait(request) {
        request.onSchedule?.(7);
        return terminal();
      },
    };

    await requestVerifiedRun(
      { target: "lint" },
      { port, fingerprint, onGeneration: (generation) => generations.push(generation) },
    );

    expect(generations).toEqual([7]);
  });

  it("reports the newest generation after a superseded retry", async () => {
    const generations: number[] = [];
    const port: VerifyPort = {
      async runAndAwait(request) {
        request.onSchedule?.(6);
        return { kind: "superseded", generation: 6, supersedingRunId: 7 };
      },
    };

    const result = await requestVerifiedRun(
      { target: "lint", timeoutMs: 120_000, matchMode: "exact" },
      { port, fingerprint, onGeneration: (generation) => generations.push(generation) },
    );

    expect(result.reason).toBe("superseded");
    expect(generations).toEqual([6, 6, 6]);
  });
});

describe("atomic acceptance", () => {
  it("accepts green only when instance, freshness, pending, and fingerprints hold", async () => {
    const { port, calls } = createFakePort([terminal()]);

    const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

    expect(result.reason).toBe("passed");
    expect(result.instance?.token).toBe("fz-7f3a");
    expect(result.freshness).toBe("current");
    expect(result.source).toBe("subscription");
    expect(result.fingerprint).toBe("abc123");
    expect(calls[0]).toEqual({ target: "lint", timeoutMs: 120_000 });
  });

  it("reports a failed run with bounded evidence", async () => {
    const failures = Array.from({ length: 50 }, (_, index) => `failure ${index}`);
    const { port } = createFakePort([
      terminal({
        snapshot: { ...SNAPSHOT, state: "failed", failures },
        status: { ...STATUS, state: "failed", failures },
      }),
    ]);

    const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

    expect(result.reason).toBe("failed");
    expect(result.failures).toHaveLength(40);
  });

  it("rejects when a newer batch is pending", async () => {
    const { port } = createFakePort([terminal({ snapshot: { ...SNAPSHOT, pending: 2 } })]);

    const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

    expect(result.reason).toBe("stale");
    expect(result.pending).toBe(2);
  });

  it("rejects when the snapshot freshness is stale or unknown", async () => {
    const stale = createFakePort([terminal({ snapshot: { ...SNAPSHOT, freshness: "stale" } })]);
    expect(
      (await requestVerifiedRun({ target: "lint" }, { port: stale.port, fingerprint })).reason,
    ).toBe("stale");

    const unknown = createFakePort([terminal({ snapshot: { ...SNAPSHOT, freshness: "unknown" } })]);
    expect(
      (await requestVerifiedRun({ target: "lint" }, { port: unknown.port, fingerprint })).reason,
    ).toBe("unknown");
  });

  it("rejects when the worktree fingerprint changed during verification", async () => {
    fingerprint.mockResolvedValueOnce("before").mockResolvedValue("after");
    const { port } = createFakePort([terminal()]);

    const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

    expect(result.reason).toBe("stale");
  });
});

describe("supersede retry policy", () => {
  it("retries a superseded run while the worktree is unchanged, bounded", async () => {
    const { port } = createFakePort([
      { kind: "superseded", generation: 6, supersedingRunId: 7 },
      terminal(),
    ]);

    const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

    expect(result.reason).toBe("passed");
    expect(result.attemptCount).toBe(2);
    expect(result.supersedingRunId).toBe(7);
  });

  it("never retries past the bound and reports the superseded reason", async () => {
    const { port } = createFakePort([
      { kind: "superseded", generation: 6, supersedingRunId: 7 },
      { kind: "superseded", generation: 7, supersedingRunId: 8 },
      { kind: "superseded", generation: 8, supersedingRunId: 9 },
    ]);

    const result = await requestVerifiedRun(
      { target: "lint" },
      { port, fingerprint, maxSupersededRetries: 2 },
    );

    expect(result.reason).toBe("superseded");
    expect(result.attemptCount).toBe(3);
    expect(result.supersedingRunId).toBe(9);
  });

  it("reports stale instead of retrying when the worktree moved", async () => {
    fingerprint.mockResolvedValueOnce("before").mockResolvedValue("after");
    const { port } = createFakePort([{ kind: "superseded", generation: 6, supersedingRunId: 7 }]);

    const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

    expect(result.reason).toBe("stale");
    expect(result.attemptCount).toBe(1);
  });
});

describe("explicit failure reasons", () => {
  it.each(["timeout", "disconnect", "restart", "cancelled"] as const)(
    "maps a %s transport outcome to its explicit reason",
    async (kind) => {
      const { port } = createFakePort([{ kind, generation: 7 }]);

      const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

      expect(result.reason).toBe(kind);
      expect(result.generation).toBe(7);
    },
  );

  it("maps an aborted signal to the aborted reason", async () => {
    const controller = new AbortController();
    const { port } = createFakePort([terminal()]);
    const signal = controller.signal;
    const abortingFingerprint = vi.fn().mockResolvedValue("abc123");
    const aborted = requestVerifiedRun(
      { target: "lint" },
      { port, fingerprint: abortingFingerprint, signal },
    );
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ reason: "aborted" });
  });

  it("maps an unknown transport failure to the unknown reason", async () => {
    const { port } = createFakePort([{ kind: "unknown", message: "boom" }]);

    const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

    expect(result.reason).toBe("unknown");
  });
});

describe("legacy polled fallback", () => {
  it("labels weaker guarantees and never equates them with atomic ones", async () => {
    const { port } = createFakePort([
      terminal({
        snapshot: null,
        source: "polled",
        status: { ...STATUS, state: "failed", failures: ["boom"] },
      }),
    ]);

    const result = await requestVerifiedRun({ target: "lint" }, { port, fingerprint });

    expect(result.reason).toBe("failed");
    expect(result.freshness).toBe("polled");
    expect(result.source).toBe("polled");
    expect(result.instance).toBeNull();
  });
});
