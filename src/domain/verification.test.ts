import { describe, expect, it } from "vitest";

import atomicRunFixture from "./fixtures/atomic-run.json" with { type: "json" };
import {
  boundEvidence,
  classifyTerminalVerification,
  decodeAtomicRunResult,
  formatVerification,
  formatVerificationProgress,
  selectTarget,
  WatcherProtocolError,
  type WatcherVerification,
} from "./verification.js";
import type { WatcherTarget } from "./watcher.js";

const TERMINAL_SNAPSHOT = {
  instance: { token: "fz-test", startedAtEpochMs: 1 },
  generation: 7,
  batchId: "b-7",
  state: "passed" as const,
  trigger: "control:lint",
  commands: ["make lint"],
  tasks: [],
  pending: 0,
  freshness: "current" as const,
  durationMs: 42,
  failures: [],
  paths: [],
  configuredConcurrency: 2,
  effectiveConcurrency: 2,
  concurrencySource: "config",
};

const TARGETS: WatcherTarget[] = [
  { name: "lint", commands: ["npm run lint"] },
  { name: "final checks @agent-final", commands: ["make all"] },
  { name: "final checks @agent-slow", commands: ["make integration"] },
];

describe("selectTarget", () => {
  it("selects an exact target name by default", () => {
    expect(selectTarget(TARGETS, "lint")).toEqual({
      kind: "selected",
      target: TARGETS[0],
    });
  });

  it("reports ambiguity with compact candidates for ambiguous default matching", () => {
    expect(selectTarget(TARGETS, "final")).toEqual({
      kind: "ambiguous",
      candidates: ["final checks @agent-final", "final checks @agent-slow"],
    });
  });

  it("selects a unique substring by default", () => {
    const targets = [{ name: "final checks @agent-final", commands: ["make all"] }];
    expect(selectTarget(targets, "final")).toEqual({
      kind: "selected",
      target: targets[0],
    });
  });

  it("selects a unique substring", () => {
    expect(selectTarget(TARGETS, "agent-slow")).toEqual({
      kind: "selected",
      target: TARGETS[2],
    });
  });

  it("reports ambiguity with candidates for multiple substring matches", () => {
    expect(selectTarget(TARGETS, "final checks")).toEqual({
      kind: "ambiguous",
      candidates: ["final checks @agent-final", "final checks @agent-slow"],
    });
  });

  it("caps candidate lists at five names", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      name: `final-${index}`,
      commands: [],
    }));
    const selection = selectTarget(many, "final-");
    expect(selection.kind).toBe("ambiguous");
    if (selection.kind !== "ambiguous") return;
    expect(selection.candidates).toHaveLength(5);
  });
});

describe("classifyTerminalVerification", () => {
  it.each([
    ["passed", "passed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["running", "unknown"],
  ] as const)("maps current terminal state %s to %s", (state, reason) => {
    expect(
      classifyTerminalVerification({
        fingerprintBefore: "same",
        fingerprintAfter: "same",
        snapshot: { ...TERMINAL_SNAPSHOT, state },
        statusState: state,
      }),
    ).toEqual({ reason, freshness: "current" });
  });

  it.each([
    [{ freshness: "stale" as const }, "stale", "stale"],
    [{ freshness: "unknown" as const }, "unknown", "unknown"],
    [{ pending: 1 }, "stale", "current"],
  ] as const)(
    "fails closed for an untrusted correlated snapshot",
    (overrides, reason, freshness) => {
      expect(
        classifyTerminalVerification({
          fingerprintBefore: "same",
          fingerprintAfter: "same",
          snapshot: { ...TERMINAL_SNAPSHOT, ...overrides },
          statusState: "passed",
        }),
      ).toEqual({ reason, freshness });
    },
  );

  it("makes changed worktree stale before accepting green", () => {
    expect(
      classifyTerminalVerification({
        fingerprintBefore: "before",
        fingerprintAfter: "after",
        snapshot: TERMINAL_SNAPSHOT,
        statusState: "passed",
      }),
    ).toEqual({ reason: "stale", freshness: "current" });
  });

  it("labels legacy status as polled without upgrading its guarantee", () => {
    expect(
      classifyTerminalVerification({
        fingerprintBefore: "same",
        fingerprintAfter: "same",
        snapshot: null,
        statusState: "failed",
      }),
    ).toEqual({ reason: "failed", freshness: "polled" });
  });
});

describe("boundEvidence", () => {
  it("bounds failure evidence by line count", () => {
    const failures = Array.from({ length: 50 }, (_, index) => `failure ${index}`);
    expect(boundEvidence(failures)).toHaveLength(40);
  });

  it("bounds failure evidence by total characters", () => {
    const failures = Array.from({ length: 10 }, () => "x".repeat(1_000));
    expect(boundEvidence(failures, 40, 4_000).join("").length).toBeLessThanOrEqual(4_000);
  });

  it("marks truncated lines explicitly", () => {
    const [line] = boundEvidence(["y".repeat(5_000)], 40, 4_000);
    expect(line).toMatch(/…$/);
  });

  it("returns empty evidence unchanged", () => {
    expect(boundEvidence([])).toEqual([]);
  });
});

describe("formatVerificationProgress", () => {
  it("reports elapsed and historical bounds without a remaining-time prediction", () => {
    expect(
      formatVerificationProgress({
        generation: 7,
        elapsedMs: 62_000,
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
      }),
    ).toBe(
      "RUNNING gen=7 elapsed=62s typical=38s upper=61s slower-than-history timeout=95s source=measured",
    );
  });
});

describe("formatVerification", () => {
  const base: WatcherVerification = {
    reason: "passed",
    target: "lint",
    instance: null,
    generation: 7,
    freshness: "current",
    source: "subscription",
    fingerprint: "abc123def456",
    fingerprintBefore: "abc123def456",
    state: "passed",
    durationMs: 42,
    failures: [],
    evidenceTruncated: false,
    pending: 0,
    supersedingRunId: null,
    attemptCount: 1,
    configuredConcurrency: 2,
    effectiveConcurrency: 2,
    concurrencySource: "config",
  };

  it("renders a compact pass with the shortened fingerprint", () => {
    expect(formatVerification(base)).toBe(
      "PASS gen=7 target=lint duration=42ms concurrency=2/2 source=config fingerprint=abc123def456",
    );
  });

  it("appends declaration-ordered terminal job timing rows", () => {
    expect(
      formatVerification({
        ...base,
        tasks: [
          { id: "first", name: "first", state: "passed", durationMs: 0 },
          { id: "checks#1", name: "second", state: "cancelled", durationMs: null },
          { id: "third", name: "third", state: "failed", durationMs: 1_500 },
        ],
      }),
    ).toBe(
      "PASS gen=7 target=lint duration=42ms concurrency=2/2 source=config fingerprint=abc123def456\njobs:\n  JOB RESULT DURATION\n  first passed 0ms\n  [checks#1] second cancelled -\n  third failed 1.5s",
    );
  });

  it("renders a fail with bounded evidence", () => {
    expect(
      formatVerification({ ...base, reason: "failed", failures: ["cargo test exited with 1"] }),
    ).toBe("FAIL gen=7 target=lint failures=1\n- cargo test exited with 1");
  });

  it("appends a copyable retrieval hint only when evidence is truncated", () => {
    expect(
      formatVerification({
        ...base,
        reason: "failed",
        target: "lint",
        failures: ["boom"],
        evidenceTruncated: true,
      }),
    ).toBe(
      "FAIL gen=7 target=lint failures=1\n- boom\nnext: watcher_output generation=7 task=lint",
    );
  });

  it("omits the retrieval hint when evidence is complete", () => {
    const text = formatVerification({
      ...base,
      reason: "failed",
      failures: ["boom"],
      evidenceTruncated: false,
    });

    expect(text).not.toContain("watcher_output");
  });

  it("appends job timing rows for a cancelled terminal verification", () => {
    expect(
      formatVerification({
        ...base,
        reason: "cancelled",
        state: "cancelled",
        tasks: [{ id: "lint", name: "lint", state: "cancelled", durationMs: null }],
      }),
    ).toBe("CANCELLED gen=7 target=lint\njobs:\n  JOB RESULT DURATION\n  lint cancelled -");
  });

  it("keeps terminal job timing visible when verification is stale", () => {
    expect(
      formatVerification({
        ...base,
        reason: "stale",
        tasks: [{ id: "lint", name: "lint", state: "passed", durationMs: 42 }],
      }),
    ).toBe("STALE gen=7 target=lint\njobs:\n  JOB RESULT DURATION\n  lint passed 42ms");
  });

  it("renders explicit non-terminal reasons", () => {
    expect(formatVerification({ ...base, reason: "superseded" })).toBe(
      "SUPERSEDED gen=7 target=lint",
    );
  });
});

describe("decodeAtomicRunResult", () => {
  it("decodes the golden atomic run fixture", () => {
    const result = decodeAtomicRunResult(atomicRunFixture);
    expect(result.runId).toBe(7);
    expect(result.snapshot.generation).toBe(7);
    expect(result.snapshot.state).toBe("passed");
    expect(result.snapshot.instance.token).toBe("fz-7f3a");
  });

  it("rejects a missing snapshot", () => {
    expect(() => decodeAtomicRunResult({ runId: 7 })).toThrow(WatcherProtocolError);
    expect(() => decodeAtomicRunResult({ runId: 7 })).toThrow(/"snapshot" is required/);
  });

  it("rejects a malformed run id", () => {
    expect(() =>
      decodeAtomicRunResult({ runId: "7", snapshot: atomicRunFixture.snapshot }),
    ).toThrow(/"runId" must be a number/);
  });
});
