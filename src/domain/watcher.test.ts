import { describe, expect, it } from "vitest";

import durationEstimateFixture from "./fixtures/duration-estimate.json" with { type: "json" };
import {
  decodeWatcherRun,
  decodeWatcherStatus,
  decodeWatcherTargets,
  WatcherProtocolError,
} from "./watcher.js";

describe("decodeWatcherStatus", () => {
  // Wire fixture exactly as the Rust control server serializes it
  // (src/control.rs: ControlState with serde camelCase).
  const rustStatusPayload = {
    schemaVersion: 2,
    generation: 4,
    state: "passed",
    trigger: "src/main.rs",
    commands: ["cargo test"],
    durationMs: 42,
    failures: [],
    services: [],
  };

  it("decodes a Rust-produced passed status", () => {
    expect(decodeWatcherStatus(rustStatusPayload)).toEqual({
      generation: 4,
      state: "passed",
      trigger: "src/main.rs",
      commands: ["cargo test"],
      durationMs: 42,
      failures: [],
      services: [],
    });
  });

  it("decodes nullable trigger and duration and every execution state", () => {
    for (const state of ["idle", "running", "failed", "cancelled"] as const) {
      expect(
        decodeWatcherStatus({
          generation: 0,
          state,
          trigger: null,
          commands: [],
          durationMs: null,
          failures: state === "failed" ? ["boom"] : [],
        }).state,
      ).toBe(state);
    }
  });

  it("requires managed services for schema two status", () => {
    expect(() => decodeWatcherStatus({ ...rustStatusPayload, services: undefined }, 2)).toThrow(
      /"services" must be an array/,
    );
    const schemaTwoWithoutServices: Record<string, unknown> = { ...rustStatusPayload };
    delete schemaTwoWithoutServices.services;
    expect(() => decodeWatcherStatus(schemaTwoWithoutServices, 2)).toThrow(
      /"services" is required/,
    );
  });

  it("rejects non-object payloads with an actionable error", () => {
    expect(() => decodeWatcherStatus("not an object")).toThrow(WatcherProtocolError);
    expect(() => decodeWatcherStatus(null)).toThrow(/status response must be a JSON object/);
    expect(() => decodeWatcherStatus([1, 2])).toThrow(/status response must be a JSON object/);
  });

  it("rejects a wrong-type generation", () => {
    expect(() => decodeWatcherStatus({ ...rustStatusPayload, generation: "4" })).toThrow(
      /"generation" must be a number, got "4"/,
    );
  });

  it("rejects a missing generation", () => {
    const withoutGeneration = { ...rustStatusPayload } as Record<string, unknown>;
    delete withoutGeneration.generation;
    expect(() => decodeWatcherStatus(withoutGeneration)).toThrow(/".*generation.*is required/);
  });

  it("rejects an unknown execution state", () => {
    expect(() => decodeWatcherStatus({ ...rustStatusPayload, state: "exploded" })).toThrow(
      /"state" must be one of idle, running, passed, failed, cancelled, got "exploded"/,
    );
  });

  it("rejects a wrong-type trigger", () => {
    expect(() => decodeWatcherStatus({ ...rustStatusPayload, trigger: 42 })).toThrow(
      /"trigger" must be a string or null, got 42/,
    );
  });

  it("rejects a wrong-type commands list", () => {
    expect(() => decodeWatcherStatus({ ...rustStatusPayload, commands: "cargo test" })).toThrow(
      /"commands" must be an array of strings, got "cargo test"/,
    );
  });

  it("rejects a wrong-type failures list", () => {
    expect(() => decodeWatcherStatus({ ...rustStatusPayload, failures: [1] })).toThrow(
      /"failures" must be an array of strings/,
    );
  });

  it("tolerates unknown extra fields for forward compatibility", () => {
    expect(decodeWatcherStatus({ ...rustStatusPayload, futureField: 1 }).generation).toBe(4);
  });
});

describe("decodeWatcherTargets", () => {
  // Wire fixture exactly as the Rust control server serializes targets
  // (src/control.rs: ControlTarget { name, commands }).
  const rustTargetsPayload = [
    { name: "final checks @agent-final", commands: ["cargo test"] },
    { name: "quick @quick", commands: ["cargo fmt", "cargo lint"] },
  ];

  it("decodes a Rust-produced targets list", () => {
    expect(decodeWatcherTargets(rustTargetsPayload)).toEqual(rustTargetsPayload);
  });

  it("decodes optional bounded duration estimates from the Rust golden fixture", () => {
    expect(decodeWatcherTargets(durationEstimateFixture.targets)).toEqual(
      durationEstimateFixture.targets,
    );
  });

  it("decodes a configured fallback estimate with no measured samples", () => {
    expect(
      decodeWatcherTargets([
        {
          name: "quick",
          commands: ["cargo test"],
          estimate: {
            typicalMs: 120_000,
            upperMs: 120_000,
            recommendedTimeoutMs: 120_000,
            samples: 0,
            confidence: "none",
            source: "configured",
          },
        },
      ]),
    ).toMatchObject([{ estimate: { source: "configured", confidence: "none", samples: 0 } }]);
  });

  it("keeps targets without estimate backward compatible", () => {
    expect(decodeWatcherTargets([{ name: "quick", commands: ["cargo test"] }])).toEqual([
      { name: "quick", commands: ["cargo test"] },
    ]);
  });

  it.each([
    ["negative duration", { ...durationEstimateFixture.estimate, typicalMs: -1 }, /safe integer/],
    [
      "unsafe duration",
      { ...durationEstimateFixture.estimate, recommendedTimeoutMs: Number.MAX_SAFE_INTEGER + 1 },
      /safe integer/,
    ],
    [
      "duration above the contract cap",
      { ...durationEstimateFixture.estimate, recommendedTimeoutMs: 900_001 },
      /must not exceed 900000/,
    ],
    [
      "inconsistent ordering",
      { ...durationEstimateFixture.estimate, upperMs: 20_000 },
      /typicalMs <= upperMs <= recommendedTimeoutMs/,
    ],
    ["inconsistent confidence", { ...durationEstimateFixture.estimate, samples: 1 }, /confidence/],
    ["unknown source", { ...durationEstimateFixture.estimate, source: "guessed" }, /source/],
  ])("rejects a malformed estimate: %s", (_scenario, estimate, error) => {
    expect(() =>
      decodeWatcherTargets([{ name: "final", commands: ["cargo test"], estimate }]),
    ).toThrow(error);
  });

  it("ignores unknown additive estimate fields", () => {
    expect(
      decodeWatcherTargets([
        {
          name: "final",
          commands: ["cargo test"],
          estimate: { ...durationEstimateFixture.estimate, futureField: "ignored" },
        },
      ]),
    ).toMatchObject([{ estimate: durationEstimateFixture.estimate }]);
  });

  it("decodes an empty targets list", () => {
    expect(decodeWatcherTargets([])).toEqual([]);
  });

  it("rejects a non-array payload", () => {
    expect(() => decodeWatcherTargets({})).toThrow(/targets response must be an array/);
  });

  it("rejects a target without a name", () => {
    expect(() => decodeWatcherTargets([{ commands: ["cargo test"] }])).toThrow(
      /target at index 0: "name" is required/,
    );
  });

  it("rejects a target with a wrong-type commands list", () => {
    expect(() => decodeWatcherTargets([{ name: "x", commands: "cargo test" }])).toThrow(
      /target at index 0: "commands" must be an array of strings/,
    );
  });

  it("rejects a non-object target entry", () => {
    expect(() => decodeWatcherTargets(["cargo test"])).toThrow(
      /target at index 0 must be a JSON object/,
    );
  });
});

describe("decodeWatcherRun", () => {
  // Wire fixture exactly as the Rust control server serializes run results
  // (src/control.rs: { "runId": <generation> }).
  const rustRunPayload = { runId: 7 };

  it("decodes a Rust-produced run id", () => {
    expect(decodeWatcherRun(rustRunPayload)).toBe(7);
  });

  it("rejects a missing runId", () => {
    expect(() => decodeWatcherRun({})).toThrow(/"runId" is required/);
  });

  it("rejects a wrong-type runId", () => {
    expect(() => decodeWatcherRun({ runId: "7" })).toThrow(/"runId" must be a number, got "7"/);
  });

  it("rejects a non-object run result", () => {
    expect(() => decodeWatcherRun(7)).toThrow(/run response must be a JSON object/);
  });
});
