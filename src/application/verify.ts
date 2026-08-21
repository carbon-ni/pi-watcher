import {
  boundEvidence,
  classifyTerminalVerification,
  type WatcherVerifyRequest,
  type WatcherVerification,
  type VerificationReason,
} from "../domain/verification.js";
import type {
  WatcherCorrelatedSnapshot,
  WatcherInstance,
  WatcherTaskOutcome,
} from "../domain/capabilities.js";
import type { WatcherObservationSource } from "../domain/observation.js";
import type { WatcherExecutionState, WatcherStatus } from "../domain/watcher.js";
import type { VerificationProgress } from "../domain/verification.js";

/**
 * Atomic verification use case (contract §4, §5).
 *
 * One injected port performs server-side run-and-await; this module owns retry,
 * progress, and result assembly while domain policy classifies terminal
 * snapshots and fingerprints. Superseded runs retry only while the worktree is
 * unchanged and only up to a bounded number of times; extension never silently
 * loops requesting expensive work.
 * The port owns transport; nothing here touches sockets.
 */

export interface AtomicRunRequest {
  target: string;
  timeoutMs: number;
  /** Explicit diagnostic override; omitted on the wire unless true. */
  sequential?: boolean;
  signal?: AbortSignal;
  /** Fires as soon as the exact run generation is known (cancel arming). */
  onSchedule?: (generation: number) => void;
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
  /** Reported as soon as the port knows the exact run generation. */
  onGeneration?: (generation: number) => void;
  /** Bounded supersede retries; the default of 2 keeps cost explicit. */
  maxSupersededRetries?: number;
  /** In-flight elapsed-time observations; never a remaining-time prediction. */
  onProgress?: (progress: VerificationProgress) => void;
}

export async function requestVerifiedRun(
  request: WatcherVerifyRequest,
  deps: VerifiedRunDeps,
): Promise<WatcherVerification> {
  const maxRetries = deps.maxSupersededRetries ?? 2;
  const fingerprintBefore = await deps.fingerprint();
  const startedAt = Date.now();
  const timeoutMs = request.timeoutMs ?? 120_000;
  const timeoutSource = request.timeoutSource ?? "default";
  const estimate = request.estimate ?? null;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  const reportProgress = (generation: number): void => {
    deps.onProgress?.({
      generation,
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
      timeoutSource,
      estimate,
    });
  };

  let attemptCount = 0;
  let reason: VerificationReason = "unknown";
  let generation: number | null = null;
  let state: WatcherExecutionState | null = null;
  let durationMs: number | null = null;
  let tasks: WatcherTaskOutcome[] = [];
  let failures: string[] = [];
  let pending: number | null = null;
  let instance: WatcherInstance | null = null;
  let freshness: WatcherVerification["freshness"] = "unknown";
  let source: WatcherObservationSource = "subscription";
  let supersedingRunId: number | null = null;
  let fingerprintAfter = fingerprintBefore;
  let configuredConcurrency: number | null = null;
  let effectiveConcurrency: number | null = null;
  let concurrencySource: string | null = null;

  try {
    while (true) {
      if (deps.signal?.aborted) {
        reason = "aborted";
        break;
      }
      const outcome = await deps.port.runAndAwait({
        target: request.target,
        timeoutMs,
        sequential: request.sequential ?? false,
        signal: deps.signal,
        onSchedule: (generation) => {
          deps.onGeneration?.(generation);
          reportProgress(generation);
          progressTimer ??= setInterval(() => reportProgress(generation), 5_000);
        },
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
            tasks = outcome.snapshot.tasks;
            instance = outcome.snapshot.instance;
            pending = outcome.snapshot.pending;
            configuredConcurrency = outcome.snapshot.configuredConcurrency;
            effectiveConcurrency = outcome.snapshot.effectiveConcurrency;
            concurrencySource = outcome.snapshot.concurrencySource;
          }
          const decision = classifyTerminalVerification({
            fingerprintBefore,
            fingerprintAfter,
            snapshot: outcome.snapshot,
            statusState: outcome.status.state,
          });
          reason = decision.reason;
          freshness = decision.freshness;
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
      instance,
      generation,
      freshness,
      source,
      fingerprint: fingerprintAfter,
      fingerprintBefore,
      state,
      durationMs,
      tasks,
      failures: boundEvidence(failures),
      evidenceTruncated: isEvidenceTruncated(failures),
      pending,
      supersedingRunId,
      attemptCount,
      configuredConcurrency,
      effectiveConcurrency,
      concurrencySource,
    };
  } finally {
    if (progressTimer !== null) clearInterval(progressTimer);
  }
}

/** True when the bounded tail cut lines or any line was shortened. */
function isEvidenceTruncated(rawFailures: string[]): boolean {
  const bounded = boundEvidence(rawFailures);
  return rawFailures.join("\n").length > bounded.join("\n").length;
}
