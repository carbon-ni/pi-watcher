import { describe, expect, it } from "vitest";

import type { WatcherObservation } from "./observation.js";
import {
  formatObservation,
  formatObservationProgress,
  observationResult,
} from "./observation-result.js";
import type { WatcherCorrelatedSnapshot } from "./capabilities.js";

const SNAPSHOT: WatcherCorrelatedSnapshot = {
  instance: { token: "fz-7f3a", startedAtEpochMs: 1710000000000 },
  generation: 7,
  batchId: "b-21",
  state: "failed",
  trigger: "src/index.ts",
  commands: ["make all"],
  tasks: [
    { id: "t-1", name: "lint", state: "failed", durationMs: 120 },
    { id: "t-2", name: "test", state: "passed", durationMs: 42 },
  ],
  pending: 0,
  freshness: "current",
  durationMs: 120,
  failures: ["boom: failed to lint", "boom: second failure"],
  paths: [],
  configuredConcurrency: 2,
  effectiveConcurrency: 2,
  concurrencySource: "config",
};

const OBSERVATION: WatcherObservation = {
  sequence: 1,
  status: {
    generation: 7,
    state: "failed",
    trigger: "src/index.ts",
    commands: ["make all"],
    durationMs: 120,
    failures: SNAPSHOT.failures,
  },
  source: "subscription",
  freshness: "current",
  snapshot: SNAPSHOT,
};

describe("observationResult", () => {
  it("maps a correlated snapshot into typed details", () => {
    const result = observationResult(OBSERVATION, "terminal");

    expect(result).toMatchObject({
      outcome: "terminal",
      instance: { token: "fz-7f3a", startedAtEpochMs: 1710000000000 },
      generation: 7,
      batchId: "b-21",
      state: "failed",
      trigger: "src/index.ts",
      source: "subscription",
      freshness: "current",
      pending: 0,
      tasks: [
        { id: "t-1", name: "lint", state: "failed", durationMs: 120 },
        { id: "t-2", name: "test", state: "passed", durationMs: 42 },
      ],
    });
  });

  it("labels a polled observation with null correlation fields", () => {
    const polled: WatcherObservation = {
      sequence: 1,
      status: {
        generation: 7,
        state: "passed",
        trigger: null,
        commands: ["make all"],
        durationMs: 42,
        failures: [],
      },
      source: "polled",
      freshness: "current",
      snapshot: null,
    };

    const result = observationResult(polled, "terminal");

    expect(result.instance).toBeNull();
    expect(result.batchId).toBeNull();
    expect(result.pending).toBeNull();
    expect(result.tasks).toEqual([]);
    expect(result.source).toBe("polled");
  });

  it("bounds failure evidence to the requested tail and marks truncation", () => {
    const manyFailures = Array.from({ length: 12 }, (_, index) => `failure ${index}`);
    const result = observationResult(
      { ...OBSERVATION, status: { ...OBSERVATION.status, failures: manyFailures } },
      "terminal",
      { maxEvidenceLines: 5 },
    );

    expect(result.failures).toHaveLength(5);
    expect(result.failures[0]).toBe("failure 0");
    expect(result.truncated).toBe(true);
    expect(result.evidenceLines).toBe(5);
  });

  it("marks a server-capped evidence tail as truncated", () => {
    const atCap = Array.from({ length: 40 }, (_, index) => `failure ${index}`);
    const result = observationResult(
      { ...OBSERVATION, status: { ...OBSERVATION.status, failures: atCap } },
      "terminal",
    );

    expect(result.failures).toHaveLength(40);
    expect(result.truncated).toBe(true);
  });

  it("leaves a short failure tail untruncated and without a next action", () => {
    const result = observationResult(OBSERVATION, "terminal");

    expect(result.truncated).toBe(false);
    expect(result.failures).toEqual(SNAPSHOT.failures);
    expect(result.nextAction).toBeNull();
  });

  it("returns a copyable next action only when evidence is truncated", () => {
    const manyFailures = Array.from({ length: 12 }, (_, index) => `failure ${index}`);
    const result = observationResult(
      { ...OBSERVATION, status: { ...OBSERVATION.status, failures: manyFailures } },
      "terminal",
      { maxEvidenceLines: 5 },
    );

    expect(result.nextAction).toBe("watcher_output generation=7 task=lint");
  });

  it("omits the task from the next action when several tasks failed", () => {
    const multiFailed: WatcherObservation = {
      ...OBSERVATION,
      snapshot: {
        ...SNAPSHOT,
        tasks: [
          { id: "t-1", name: "lint", state: "failed", durationMs: 120 },
          { id: "t-2", name: "test", state: "failed", durationMs: 42 },
        ],
      },
    };
    const result = observationResult(multiFailed, "terminal", { maxEvidenceLines: 1 });

    expect(result.nextAction).toBe("watcher_output generation=7");
  });

  it("honors zero evidence lines and still offers the retrieval hint", () => {
    const result = observationResult(OBSERVATION, "terminal", { maxEvidenceLines: 0 });

    expect(result.failures).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.nextAction).toBe("watcher_output generation=7 task=lint");
  });

  it("keeps the retrieval hint on the polled path without task identity", () => {
    const polled: WatcherObservation = {
      sequence: 1,
      status: {
        generation: 7,
        state: "failed",
        trigger: null,
        commands: ["make all"],
        durationMs: 120,
        failures: Array.from({ length: 45 }, (_, index) => `failure ${index}`),
      },
      source: "polled",
      freshness: "current",
      snapshot: null,
    };

    const result = observationResult(polled, "terminal");

    expect(result.nextAction).toBe("watcher_output generation=7");
    expect(result.truncated).toBe(true);
  });
});

describe("formatObservation", () => {
  it("formats a passed terminal observation compactly", () => {
    const result = observationResult(
      { ...OBSERVATION, status: { ...OBSERVATION.status, state: "passed", failures: [] } },
      "terminal",
    );

    expect(formatObservation(result)).toBe(
      "PASS gen=7 freshness=current duration=120ms concurrency=2/2 source=config\njobs:\n  JOB RESULT DURATION\n  [t-1] lint failed 120ms\n  [t-2] test passed 42ms",
    );
  });

  it("appends declaration-ordered job timing rows and renders absent duration as a dash", () => {
    const result = observationResult(
      {
        ...OBSERVATION,
        status: { ...OBSERVATION.status, state: "passed", failures: [] },
        snapshot: {
          ...SNAPSHOT,
          state: "passed",
          tasks: [
            { id: "first", name: "first", state: "passed", durationMs: 0 },
            { id: "checks#1", name: "second", state: "cancelled", durationMs: null },
            { id: "third", name: "third", state: "failed", durationMs: 1_500 },
          ],
        },
      },
      "terminal",
    );

    expect(formatObservation(result)).toBe(
      "PASS gen=7 freshness=current duration=120ms concurrency=2/2 source=config\njobs:\n  JOB RESULT DURATION\n  first passed 0ms\n  [checks#1] second cancelled -\n  third failed 1.5s",
    );
  });

  it("formats a failed terminal observation with task, evidence, and next action", () => {
    const manyFailures = Array.from({ length: 12 }, (_, index) => `failure ${index}`);
    const result = observationResult(
      { ...OBSERVATION, status: { ...OBSERVATION.status, failures: manyFailures } },
      "terminal",
      { maxEvidenceLines: 2 },
    );

    expect(formatObservation(result)).toBe(
      "FAIL gen=7 freshness=current task=lint duration=120ms\n  - failure 0\n  - failure 1\nnext: watcher_output generation=7 task=lint\njobs:\n  JOB RESULT DURATION\n  [t-1] lint failed 120ms\n  [t-2] test passed 42ms",
    );
  });

  it("counts failed tasks when several failed", () => {
    const multiFailed: WatcherObservation = {
      ...OBSERVATION,
      snapshot: {
        ...SNAPSHOT,
        tasks: [
          { id: "t-1", name: "lint", state: "failed", durationMs: 120 },
          { id: "t-2", name: "test", state: "failed", durationMs: 42 },
        ],
      },
    };

    expect(formatObservation(observationResult(multiFailed, "terminal"))).toBe(
      "FAIL gen=7 freshness=current tasks=2 failed duration=120ms\n  - boom: failed to lint\n  - boom: second failure\njobs:\n  JOB RESULT DURATION\n  [t-1] lint failed 120ms\n  [t-2] test failed 42ms",
    );
  });

  it("formats a running snapshot observation", () => {
    const result = observationResult(
      { ...OBSERVATION, status: { ...OBSERVATION.status, state: "running", failures: [] } },
      "snapshot",
    );

    expect(formatObservation(result)).toBe(
      "RUNNING gen=7 freshness=current concurrency=2/2 source=config",
    );
  });

  it("formats an explicit no-op state distinguishable from transport failure", () => {
    const idle: WatcherObservation = {
      sequence: 1,
      status: {
        generation: 0,
        state: "idle",
        trigger: null,
        commands: [],
        durationMs: null,
        failures: [],
      },
      source: "subscription",
      freshness: "current",
      snapshot: {
        instance: { token: "fz-7f3a", startedAtEpochMs: 1710000000000 },
        generation: 0,
        batchId: "b-0",
        state: "idle",
        trigger: null,
        commands: [],
        tasks: [],
        pending: 0,
        freshness: "current",
        durationMs: null,
        failures: [],
        paths: [],
        configuredConcurrency: 2,
        effectiveConcurrency: 2,
        concurrencySource: "config",
      },
    };

    expect(formatObservation(observationResult(idle, "noop"))).toBe(
      "NOOP gen=0 freshness=current (nothing pending)",
    );
  });

  it("formats superseded, timeout, disconnect, aborted, stale, and unknown outcomes", () => {
    const result = observationResult(OBSERVATION, "superseded", { supersedingGeneration: 8 });
    expect(formatObservation(result)).toBe("SUPERSEDED gen=7 freshness=current supersededBy=8");

    expect(formatObservation(observationResult(OBSERVATION, "timeout", { waitedMs: 30_000 }))).toBe(
      "TIMEOUT gen=7 freshness=current waited=30s",
    );

    expect(formatObservation(observationResult(OBSERVATION, "disconnect"))).toBe(
      "DISCONNECTED gen=7 freshness=current",
    );

    expect(formatObservation(observationResult(OBSERVATION, "aborted"))).toBe(
      "ABORTED gen=7 freshness=current",
    );

    expect(
      formatObservation(observationResult({ ...OBSERVATION, freshness: "stale" }, "stale")),
    ).toBe("STALE gen=7 freshness=stale");

    expect(
      formatObservation(
        observationResult(OBSERVATION, "unknown", { message: "malformed snapshot" }),
      ),
    ).toBe("UNKNOWN gen=7 freshness=current message=malformed snapshot");
  });

  it("marks polled observations with the weaker-freshness suffix", () => {
    const polled: WatcherObservation = {
      sequence: 1,
      status: {
        generation: 7,
        state: "passed",
        trigger: null,
        commands: ["make all"],
        durationMs: 42,
        failures: [],
      },
      source: "polled",
      freshness: "current",
      snapshot: null,
    };

    expect(formatObservation(observationResult(polled, "snapshot"))).toBe(
      "PASS gen=7 freshness=current duration=42ms (polled)",
    );
  });

  it("formats an empty result for null observations (aborted before any data)", () => {
    expect(formatObservation(observationResult(null, "aborted"))).toBe("ABORTED freshness=unknown");
  });
});

describe("formatObservationProgress", () => {
  it("renders a compact in-flight observation", () => {
    expect(formatObservationProgress(OBSERVATION)).toBe("FAIL gen=7 freshness=current");
  });

  it("labels exact-generation progress without changing observed generation", () => {
    expect(formatObservationProgress(OBSERVATION, { generation: 7 })).toBe(
      "FAIL gen=7 waitingForGeneration=7 freshness=current",
    );
  });

  it.each(["passed", "failed", "cancelled", "running", "idle"] as const)(
    "labels excluded fresh-anchor %s progress with selector context",
    (state) => {
      expect(
        formatObservationProgress(
          { ...OBSERVATION, status: { ...OBSERVATION.status, state } },
          { afterGeneration: 7 },
        ),
      ).toBe(`WAITING gen>7 current=7 state=${state} excluded=true freshness=current`);
    },
  );

  it("labels an observed newer generation as selected after the selector", () => {
    expect(formatObservationProgress(OBSERVATION, { afterGeneration: 6 })).toBe(
      "FAIL gen=7 selectedAfter=6 freshness=current",
    );
  });

  it("keeps selector context when a wait times out before a newer generation", () => {
    const baseline = { ...OBSERVATION, status: { ...OBSERVATION.status, generation: 16 } };
    expect(
      formatObservation(
        observationResult(baseline, "timeout", { waitedMs: 600_000, afterGeneration: 16 }),
      ),
    ).toBe(
      "TIMEOUT gen>16 current=16 state=failed excluded=true freshness=current waited=600s\nnext: watcher_observe wait=true generation=16",
    );
  });

  it("hints at a matching trigger when no generation exists for a selector wait", () => {
    expect(
      formatObservation(
        observationResult(null, "timeout", { waitedMs: 600_000, afterGeneration: 7 }),
      ),
    ).toBe(
      "TIMEOUT gen>7 current=none state=unknown excluded=true freshness=unknown waited=600s\nnext: trigger a matching change before watcher_observe wait=true afterGeneration=7",
    );
  });

  it("marks polled progress with the weaker-freshness suffix", () => {
    const polled: WatcherObservation = {
      sequence: 1,
      status: {
        generation: 7,
        state: "running",
        trigger: null,
        commands: ["make all"],
        durationMs: null,
        failures: [],
      },
      source: "polled",
      freshness: "current",
      snapshot: null,
    };

    expect(formatObservationProgress(polled)).toBe("RUNNING gen=7 freshness=current (polled)");
  });
});
