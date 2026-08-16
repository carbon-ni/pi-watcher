import { describe, expect, it } from "vitest";

import { selectVerificationTimeout } from "./timeout-selection.js";

const measured = {
  typicalMs: 38_000,
  upperMs: 61_000,
  recommendedTimeoutMs: 95_000,
  samples: 12,
  confidence: "high" as const,
  source: "measured" as const,
};

describe("selectVerificationTimeout", () => {
  it("prefers an explicit bounded caller timeout", () => {
    expect(
      selectVerificationTimeout({ explicitTimeoutMs: 30_000, estimate: measured }),
    ).toMatchObject({
      milliseconds: 30_000,
      source: "explicit",
    });
  });

  it("uses a negotiated measured recommendation", () => {
    expect(
      selectVerificationTimeout({ durationEstimatesSupported: true, estimate: measured }),
    ).toEqual({
      milliseconds: 95_000,
      source: "measured",
      estimate: measured,
    });
  });

  it("uses a configured estimate only after measured history", () => {
    expect(
      selectVerificationTimeout({
        durationEstimatesSupported: true,
        estimate: { ...measured, samples: 0, confidence: "none", source: "configured" },
      }),
    ).toMatchObject({ source: "configured", milliseconds: 95_000 });
  });

  it("never reuses a parallel estimate for an explicit sequential run", () => {
    expect(
      selectVerificationTimeout({
        sequential: true,
        durationEstimatesSupported: true,
        estimate: measured,
      }),
    ).toMatchObject({ milliseconds: 120_000, source: "default", estimate: null });
  });

  it("falls back for unsupported, absent, or malformed estimates", () => {
    expect(
      selectVerificationTimeout({ durationEstimatesSupported: false, estimate: measured }),
    ).toEqual({
      milliseconds: 120_000,
      source: "default",
      estimate: null,
    });
    expect(
      selectVerificationTimeout({ durationEstimatesSupported: true, estimate: undefined }),
    ).toMatchObject({
      source: "default",
    });
    expect(
      selectVerificationTimeout({
        durationEstimatesSupported: true,
        estimate: { ...measured, recommendedTimeoutMs: 900_001 },
      }),
    ).toMatchObject({ source: "default" });
  });

  it("rejects an explicit timeout beyond the shared absolute bound", () => {
    expect(() => selectVerificationTimeout({ explicitTimeoutMs: 900_001 })).toThrow(
      /must not exceed/,
    );
  });
});
