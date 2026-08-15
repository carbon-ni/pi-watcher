import { MAX_RECOMMENDED_TIMEOUT_MS, type WatcherDurationEstimate } from "./duration-estimate.js";

export type TimeoutSource = "explicit" | "measured" | "configured" | "default";

export interface TimeoutSelection {
  milliseconds: number;
  source: TimeoutSource;
  estimate: WatcherDurationEstimate | null;
}

export interface TimeoutSelectionInput {
  explicitTimeoutMs?: number;
  durationEstimatesSupported?: boolean;
  estimate?: WatcherDurationEstimate;
  configuredTimeoutMs?: number;
  /** A target-list estimate describes normal scheduling, never an override. */
  sequential?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Deterministic timeout precedence; estimates are hints, never extensions. */
export function selectVerificationTimeout(input: TimeoutSelectionInput): TimeoutSelection {
  if (input.explicitTimeoutMs !== undefined) {
    return {
      milliseconds: validateTimeout(input.explicitTimeoutMs),
      source: "explicit",
      estimate: null,
    };
  }

  const estimate =
    input.durationEstimatesSupported && !input.sequential ? input.estimate : undefined;
  if (estimate !== undefined && validEstimate(estimate)) {
    return {
      milliseconds: estimate.recommendedTimeoutMs,
      source: estimate.source,
      estimate,
    };
  }

  if (input.configuredTimeoutMs !== undefined) {
    return {
      milliseconds: validateTimeout(input.configuredTimeoutMs),
      source: "configured",
      estimate: null,
    };
  }

  return { milliseconds: DEFAULT_TIMEOUT_MS, source: "default", estimate: null };
}

function validEstimate(estimate: WatcherDurationEstimate): boolean {
  return (
    Number.isSafeInteger(estimate.typicalMs) &&
    Number.isSafeInteger(estimate.upperMs) &&
    Number.isSafeInteger(estimate.recommendedTimeoutMs) &&
    estimate.typicalMs >= 0 &&
    estimate.typicalMs <= estimate.upperMs &&
    estimate.upperMs <= estimate.recommendedTimeoutMs &&
    estimate.recommendedTimeoutMs <= MAX_RECOMMENDED_TIMEOUT_MS
  );
}

function validateTimeout(milliseconds: number): number {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new RangeError("Funzzy verification timeout must be a positive safe integer");
  }
  if (milliseconds > MAX_RECOMMENDED_TIMEOUT_MS) {
    throw new RangeError(
      `Funzzy verification timeout must not exceed ${MAX_RECOMMENDED_TIMEOUT_MS}ms`,
    );
  }
  return milliseconds;
}
