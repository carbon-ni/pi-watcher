import { describeValue, expectObject, WatcherProtocolError } from "./protocol.js";

export const MAX_RECOMMENDED_TIMEOUT_MS = 15 * 60_000;
const MAX_DURATION_SAMPLES = 20;

export type WatcherDurationConfidence = "none" | "low" | "medium" | "high";
export type WatcherDurationSource = "configured" | "measured";

/** A bounded historical duration hint. It is never a deadline guarantee. */
export interface WatcherDurationEstimate {
  typicalMs: number;
  upperMs: number;
  recommendedTimeoutMs: number;
  samples: number;
  confidence: WatcherDurationConfidence;
  source: WatcherDurationSource;
}

/** Decode an additive estimate field; omission preserves legacy behavior. */
export function readOptionalDurationEstimate(
  object: Record<string, unknown>,
  what: string,
): WatcherDurationEstimate | null {
  if (!("estimate" in object)) return null;

  const estimate = expectObject(object["estimate"], `${what} estimate`);
  const typicalMs = readDurationInteger(estimate, "typicalMs", what);
  const upperMs = readDurationInteger(estimate, "upperMs", what);
  const recommendedTimeoutMs = readDurationInteger(estimate, "recommendedTimeoutMs", what);
  const samples = readSampleCount(estimate, what);
  const confidence = readConfidence(estimate, what);
  const source = readSource(estimate, what);

  if (typicalMs > upperMs || upperMs > recommendedTimeoutMs) {
    throw new WatcherProtocolError(
      `Funzzy ${what} estimate: "typicalMs <= upperMs <= recommendedTimeoutMs" is required`,
    );
  }
  if (recommendedTimeoutMs > MAX_RECOMMENDED_TIMEOUT_MS) {
    throw new WatcherProtocolError(
      `Funzzy ${what} estimate: "recommendedTimeoutMs" must not exceed ${MAX_RECOMMENDED_TIMEOUT_MS}`,
    );
  }
  if (confidence !== confidenceForSamples(samples)) {
    throw new WatcherProtocolError(
      `Funzzy ${what} estimate: "confidence" is inconsistent with "samples"`,
    );
  }
  if ((source === "measured") !== samples > 0) {
    throw new WatcherProtocolError(
      `Funzzy ${what} estimate: "source" is inconsistent with "samples"`,
    );
  }

  return { typicalMs, upperMs, recommendedTimeoutMs, samples, confidence, source };
}

function readDurationInteger(object: Record<string, unknown>, field: string, what: string): number {
  const value = object[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WatcherProtocolError(
      `Funzzy ${what} estimate: "${field}" must be a non-negative safe integer, got ${describeValue(value)}`,
    );
  }
  return value as number;
}

function readSampleCount(object: Record<string, unknown>, what: string): number {
  const samples = readDurationInteger(object, "samples", what);
  if (samples > MAX_DURATION_SAMPLES) {
    throw new WatcherProtocolError(
      `Funzzy ${what} estimate: "samples" must not exceed ${MAX_DURATION_SAMPLES}`,
    );
  }
  return samples;
}

function readConfidence(object: Record<string, unknown>, what: string): WatcherDurationConfidence {
  const value = object["confidence"];
  if (value === "none" || value === "low" || value === "medium" || value === "high") return value;
  throw new WatcherProtocolError(
    `Funzzy ${what} estimate: "confidence" must be one of none, low, medium, high, got ${describeValue(value)}`,
  );
}

function readSource(object: Record<string, unknown>, what: string): WatcherDurationSource {
  const value = object["source"];
  if (value === "configured" || value === "measured") return value;
  throw new WatcherProtocolError(
    `Funzzy ${what} estimate: "source" must be one of configured, measured, got ${describeValue(value)}`,
  );
}

function confidenceForSamples(samples: number): WatcherDurationConfidence {
  if (samples === 0) return "none";
  if (samples <= 2) return "low";
  if (samples <= 9) return "medium";
  return "high";
}
