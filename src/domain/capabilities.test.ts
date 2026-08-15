import { describe, expect, it } from "vitest";

import capabilitiesFixture from "./fixtures/capabilities.json" with { type: "json" };
import correlatedSnapshotFixture from "./fixtures/correlated-snapshot.json" with { type: "json" };
import {
  decodeWatcherCapabilities,
  decodeWatcherCorrelatedSnapshot,
  hasMethod,
  LEGACY_CAPABILITY_PROFILE,
  WatcherProtocolError,
} from "./capabilities.js";

describe("decodeWatcherCapabilities", () => {
  // Minimum payload: a server that only reports identity and supported methods.
  const minimum = {
    protocolVersion: "1.1",
    schemaVersion: 2,
    instance: { token: "fz-7f3a" },
    methods: ["status", "targets", "run"],
  };

  it("decodes a minimal capabilities payload with documented defaults", () => {
    expect(decodeWatcherCapabilities(minimum)).toEqual({
      source: "negotiated",
      protocolVersion: "1.1",
      schemaVersion: 2,
      instance: { token: "fz-7f3a", startedAtEpochMs: null },
      methods: ["status", "targets", "run"],
      optionalFields: [],
      limits: { outputRetentionBytes: 0, maxResponseBytes: 65536, maxEvidenceLines: 40 },
      features: {
        atomicAwait: false,
        subscription: false,
        correlatedSnapshots: false,
        outputRetrieval: false,
        pendingWork: false,
        sequentialOverride: false,
      },
    });
  });

  it("decodes the golden full fixture negotiated from Funzzy", () => {
    const profile = decodeWatcherCapabilities(capabilitiesFixture);
    expect(profile.source).toBe("negotiated");
    expect(profile.instance.token).toBe("fz-7f3a");
    expect(profile.instance.startedAtEpochMs).toBe(1710000000000);
    expect(profile.methods).toContain("subscribe");
    expect(profile.optionalFields).toEqual(["batchId", "pending", "tasks", "paths"]);
    expect(profile.limits.outputRetentionBytes).toBe(1048576);
    expect(profile.features).toEqual({
      atomicAwait: true,
      subscription: true,
      correlatedSnapshots: true,
      outputRetrieval: true,
      pendingWork: true,
      sequentialOverride: true,
    });
  });

  it("rejects a malformed protocol version", () => {
    expect(() => decodeWatcherCapabilities({ ...minimum, protocolVersion: 1.1 })).toThrow(
      WatcherProtocolError,
    );
    expect(() => decodeWatcherCapabilities({ ...minimum, protocolVersion: 1.1 })).toThrow(
      /"protocolVersion" must be a string/,
    );
  });

  it("rejects a malformed schema version", () => {
    expect(() => decodeWatcherCapabilities({ ...minimum, schemaVersion: "2" })).toThrow(
      /"schemaVersion" must be a number/,
    );
  });

  it("rejects a malformed methods list", () => {
    expect(() => decodeWatcherCapabilities({ ...minimum, methods: "status" })).toThrow(
      /"methods" must be an array of strings/,
    );
    expect(() => decodeWatcherCapabilities({ ...minimum, methods: ["status", 42] })).toThrow(
      /"methods" must be an array of strings/,
    );
  });

  it("rejects malformed output limits", () => {
    expect(() => decodeWatcherCapabilities({ ...minimum, limits: 1024 })).toThrow(
      /"limits" must be an object/,
    );
    expect(() =>
      decodeWatcherCapabilities({
        ...minimum,
        limits: { outputRetentionBytes: "many", maxResponseBytes: 65536, maxEvidenceLines: 40 },
      }),
    ).toThrow(/"outputRetentionBytes" must be a number/);
  });

  it("rejects a malformed instance identity", () => {
    expect(() => decodeWatcherCapabilities({ ...minimum, instance: null })).toThrow(
      /"instance" must be an object/,
    );
    expect(() =>
      decodeWatcherCapabilities({ ...minimum, instance: { startedAtEpochMs: 1 } }),
    ).toThrow(/"token" is required/);
    expect(() =>
      decodeWatcherCapabilities({
        ...minimum,
        instance: { token: "fz-7f3a", startedAtEpochMs: "now" },
      }),
    ).toThrow(/"startedAtEpochMs" must be a number or null/);
  });

  it("rejects a non-boolean feature flag", () => {
    expect(() =>
      decodeWatcherCapabilities({
        ...minimum,
        features: { atomicAwait: "yes", subscription: false },
      }),
    ).toThrow(/"features.atomicAwait" must be a boolean/);
  });
});

describe("decodeWatcherCorrelatedSnapshot", () => {
  // Minimum payload: identity, batch, and terminal state with no task detail.
  const minimum = {
    instance: { token: "fz-7f3a" },
    generation: 4,
    batchId: "b-19",
    state: "passed",
    tasks: [],
    pending: 0,
    freshness: "current",
  };

  it("decodes a minimal correlated snapshot with defaults", () => {
    expect(decodeWatcherCorrelatedSnapshot(minimum)).toEqual({
      instance: { token: "fz-7f3a", startedAtEpochMs: null },
      generation: 4,
      batchId: "b-19",
      state: "passed",
      trigger: null,
      commands: [],
      tasks: [],
      pending: 0,
      freshness: "current",
      durationMs: null,
      failures: [],
      paths: [],
      configuredConcurrency: 1,
      effectiveConcurrency: 1,
      concurrencySource: "config",
    });
  });

  it("decodes the golden full correlated snapshot fixture", () => {
    const snapshot = decodeWatcherCorrelatedSnapshot(correlatedSnapshotFixture);
    expect(snapshot.instance.token).toBe("fz-7f3a");
    expect(snapshot.batchId).toBe("b-19");
    expect(snapshot.freshness).toBe("current");
    expect(snapshot.commands).toEqual(["make all"]);
    expect(snapshot.tasks).toEqual([
      { id: "t-1", name: "test @agent-final", state: "passed", durationMs: 42 },
    ]);
    expect(snapshot.paths).toEqual(["src/main.rs", "src/lib.rs"]);
    expect(snapshot.configuredConcurrency).toBe(2);
    expect(snapshot.effectiveConcurrency).toBe(2);
    expect(snapshot.concurrencySource).toBe("config");
  });

  it("defaults missing batch paths to an empty list", () => {
    expect(decodeWatcherCorrelatedSnapshot(minimum).paths).toEqual([]);
  });

  it("rejects a malformed batch field", () => {
    expect(() => decodeWatcherCorrelatedSnapshot({ ...minimum, batchId: 19 })).toThrow(
      /"batchId" must be a string/,
    );
    expect(() => {
      const { batchId, ...rest } = minimum;
      void batchId;
      return decodeWatcherCorrelatedSnapshot(rest);
    }).toThrow(/"batchId" is required/);
  });

  it("rejects an unknown freshness value", () => {
    expect(() => decodeWatcherCorrelatedSnapshot({ ...minimum, freshness: "fresh" })).toThrow(
      /"freshness" must be one of current, stale, unknown/,
    );
  });

  it("rejects a malformed tasks field", () => {
    expect(() => decodeWatcherCorrelatedSnapshot({ ...minimum, tasks: "passed" })).toThrow(
      /"tasks" must be an array of objects/,
    );
    expect(() =>
      decodeWatcherCorrelatedSnapshot({ ...minimum, tasks: [{ id: "t-1", state: "passed" }] }),
    ).toThrow(/task at index 0: "name" is required/);
    expect(() =>
      decodeWatcherCorrelatedSnapshot({
        ...minimum,
        tasks: [{ id: "t-1", name: "test", state: "green" }],
      }),
    ).toThrow(/task at index 0: "state" must be one of passed, failed, cancelled/);
  });

  it("rejects a malformed snapshot identity", () => {
    expect(() => decodeWatcherCorrelatedSnapshot({ ...minimum, instance: {} })).toThrow(
      /"token" is required/,
    );
  });

  it("rejects a malformed pending count", () => {
    expect(() => decodeWatcherCorrelatedSnapshot({ ...minimum, pending: "none" })).toThrow(
      /"pending" must be a number/,
    );
  });
});

describe("capability policy surface", () => {
  it("checks supported methods against a profile", () => {
    expect(hasMethod(LEGACY_CAPABILITY_PROFILE, "status")).toBe(true);
    expect(hasMethod(LEGACY_CAPABILITY_PROFILE, "subscribe")).toBe(false);
    expect(hasMethod(decodeWatcherCapabilities(capabilitiesFixture), "cancel")).toBe(true);
  });

  it("labels the legacy profile with weaker guarantees", () => {
    expect(LEGACY_CAPABILITY_PROFILE.source).toBe("legacy");
    expect(LEGACY_CAPABILITY_PROFILE.features.atomicAwait).toBe(false);
    expect(LEGACY_CAPABILITY_PROFILE.features.subscription).toBe(false);
    expect(LEGACY_CAPABILITY_PROFILE.features.correlatedSnapshots).toBe(false);
    expect(LEGACY_CAPABILITY_PROFILE.methods).toEqual(["status", "targets", "run"]);
  });
});
