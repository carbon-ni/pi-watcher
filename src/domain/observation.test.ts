import { describe, expect, it } from "vitest";

import {
  observationFooterSuffix,
  shouldForwardObservation,
  type WatcherObservation,
} from "./observation.js";

const OBSERVATION: WatcherObservation = {
  sequence: 1,
  status: {
    generation: 4,
    state: "running",
    trigger: "src/main.rs",
    commands: ["cargo test"],
    durationMs: null,
    failures: [],
  },
  source: "subscription",
  freshness: "current",
  snapshot: null,
};

describe("shouldForwardObservation", () => {
  it("forwards the first observation of a stream", () => {
    expect(shouldForwardObservation(null, OBSERVATION)).toBe(true);
  });

  it("forwards a strictly newer sequence", () => {
    expect(shouldForwardObservation(OBSERVATION, { ...OBSERVATION, sequence: 2 })).toBe(true);
  });

  it("skips a duplicate sequence even when state changed", () => {
    const duplicateWithNewState: WatcherObservation = {
      ...OBSERVATION,
      status: { ...OBSERVATION.status, state: "passed" },
    };
    expect(shouldForwardObservation(OBSERVATION, duplicateWithNewState)).toBe(false);
  });

  it("skips an out-of-order older sequence", () => {
    expect(shouldForwardObservation({ ...OBSERVATION, sequence: 5 }, OBSERVATION)).toBe(false);
  });
});

describe("observationFooterSuffix", () => {
  it("marks polled observations with the weaker-freshness label", () => {
    expect(observationFooterSuffix("polled")).toBe(" (polled)");
  });

  it("leaves subscription observations unlabeled", () => {
    expect(observationFooterSuffix("subscription")).toBe("");
  });
});
