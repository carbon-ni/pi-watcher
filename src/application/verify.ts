import {
  boundEvidence,
  type WatcherVerifyRequest,
  type WatcherVerification,
  type VerificationReason,
} from "../domain/verification.js";
import type { WatcherCorrelatedSnapshot, WatcherInstance } from "../domain/capabilities.js";
import type { WatcherObservationSource } from "../domain/observation.js";
import type { WatcherExecutionState, WatcherStatus } from "../domain/watcher.js";

/**
 * Atomic verification use case (contract §4, §5).
 *
 * One injected port performs the server-side run-and-await; this module owns
 * acceptance policy: instance continuity, snapshot freshness, pending-work
 * invalidation, and before/after worktree fingerprints. Superseded runs retry
 * only while the worktree is unchanged and only up to a bounded number of
 * times; the extension never silently loops requesting expensive work.
 * The port owns transport; nothing here touches sockets.
 */

export interface AtomicRunRequest {
  target: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type AtomicRunOutcome =
  | {
      kind: "terminal";
      generation: number;
      status: WatcherStatus;
      /** Present on the atomic path; null labels the weaker polled fallback. */
      snapshot: WatcherCorrelatedSnapshot | null;
      source: WatcherObservationSource;
    }
  | { kind: "superseded"; generation: number | null; supersedingRunId: number }
  | { kind: "timeout" | "disconnect" | "restart" | "cancelled"; generation: number | null }
  | { kind: "aborted" }
  | { kind: "unknown"; message: string };

export interface VerifyPort {
  runAndAwait(request: AtomicRunRequest): Promise<AtomicRunOutcome>;
}

export interface VerifiedRunDeps {
  port: VerifyPort;
  fingerprint: () => Promise<string>;
  signal?: AbortSignal;
  /** Bounded supersede retries; the default of 2 keeps cost explicit. */
  maxSupersededRetries?: number;
}

export async function requestVerifiedRun(
  request: WatcherVerifyRequest,
  deps: VerifiedRunDeps,
): Promise<WatcherVerification> {
  const maxRetries = deps.maxSupersededRetries ?? 2;
  const matchMode = request.matchMode ?? "exact";
  const timeoutMs = request.timeoutMs ?? 120_000;
  const fingerprintBefore = await deps.fingerprint();

  let attemptCount = 0;
  let reason: VerificationReason = "unknown";
  let generation: number | null = null;
  let state: WatcherExecutionState | null = null;
  let durationMs: number | null = null;
  let failures: string[] = [];
  let pending: number | null = null;
  let instance: WatcherInstance | null = null;
  let freshness: WatcherVerification["freshness"] = "unknown";
  let source: WatcherObservationSource = "subscription";
  let supersedingRunId: number | null = null;
  let fingerprintAfter = fingerprintBefore;

  while (true) {
    if (deps.signal?.aborted) {
      reason = "aborted";
      break;
    }
    const outcome = await deps.port.runAndAwait({
      target: request.target,
      timeoutMs,
      signal: deps.signal,
    });
    attemptCount += 1;

    switch (outcome.kind) {
      case "superseded": {
        supersedingRunId = outcome.supersedingRunId;
        generation = outcome.generation ?? generation;
        if (attemptCount > maxRetries) {
          reason = "superseded";
          fingerprintAfter = await deps.fingerprint();
          break;
        }
        // Retry only while the worktree is unchanged; otherwise the superseded
        // outcome belongs to work the agent already moved past.
        fingerprintAfter = await deps.fingerprint();
        if (fingerprintAfter !== fingerprintBefore) {
          reason = "stale";
          break;
        }
        continue;
      }

      case "terminal": {
        generation = outcome.generation;
        state = outcome.status.state;
        durationMs = outcome.status.durationMs;
        failures = outcome.status.failures;
        source = outcome.source;
        fingerprintAfter = await deps.fingerprint();

        if (outcome.snapshot !== null) {
          instance = outcome.snapshot.instance;
          freshness = outcome.snapshot.freshness;
          pending = outcome.snapshot.pending;
          if (fingerprintAfter !== fingerprintBefore) {
            reason = "stale";
          } else if (outcome.snapshot.freshness === "unknown") {
            reason = "unknown";
          } else if (outcome.snapshot.freshness !== "current" || outcome.snapshot.pending > 0) {
            reason = "stale";
          } else if (outcome.snapshot.state === "passed") {
            reason = "passed";
          } else if (outcome.snapshot.state === "failed") {
            reason = "failed";
          } else if (outcome.snapshot.state === "cancelled") {
            reason = "cancelled";
          } else {
            reason = "unknown";
          }
        } else {
          // Legacy polled fallback: no correlation fields, so guarantees are
          // weaker and labeled, never equated with the atomic path (contract §8).
          freshness = "polled";
          if (fingerprintAfter !== fingerprintBefore) {
            reason = "stale";
          } else if (outcome.status.state === "passed") {
            reason = "passed";
          } else if (outcome.status.state === "failed") {
            reason = "failed";
          } else if (outcome.status.state === "cancelled") {
            reason = "cancelled";
          } else {
            reason = "unknown";
          }
        }
        break;
      }

      case "timeout":
      case "disconnect":
      case "restart":
      case "cancelled": {
        generation = outcome.generation;
        reason = outcome.kind;
        break;
      }

      case "aborted":
      case "unknown": {
        reason = outcome.kind;
        break;
      }
    }
    break;
  }

  return {
    reason,
    target: request.target,
    matchMode,
    instance,
    generation,
    freshness,
    source,
    fingerprint: fingerprintAfter,
    fingerprintBefore,
    state,
    durationMs,
    failures: boundEvidence(failures),
    evidenceTruncated: isEvidenceTruncated(failures),
    pending,
    supersedingRunId,
    attemptCount,
  };
}

/** True when the bounded tail cut lines or any line was shortened. */
function isEvidenceTruncated(rawFailures: string[]): boolean {
  const bounded = boundEvidence(rawFailures);
  return rawFailures.join("\n").length > bounded.join("\n").length;
}
