import type { WatcherObservation } from "../domain/observation.js";
import {
  observationResult,
  type ObservationOutcome,
  type WatcherObserveRequest,
  type WatcherObservationResult,
} from "../domain/observation-result.js";
import type { WatcherExecutionState } from "../domain/watcher.js";
import type { ObserverPort } from "./observer.js";

/**
 * Observation use case (contract §7): snapshot or bounded wait over one
 * injected observer port. This module owns the deterministic wait policy —
 * terminal completion, explicit no-op, supersession, timeout, abort, and
 * freshness labeling — and never touches sockets. The port owns transport;
 * error classification is injected from infra so this layer stays free of
 * transport imports.
 *
 * Observation never triggers or cancels Funzzy work: the AbortSignal only
 * ends the wait, and the port is torn down in `finally`.
 */

const TERMINAL_STATES: ReadonlySet<WatcherExecutionState> = new Set([
  "passed",
  "failed",
  "cancelled",
]);

export interface ObserveDeps {
  port: ObserverPort;
  signal?: AbortSignal;
  /** Every observation of a wait, for rate-bounded progress updates. */
  onObservation?: (observation: WatcherObservation) => void;
  /** Infra-owned transport vs payload classification; never guessed here. */
  classifyError: (error: unknown) => "disconnect" | "unknown";
  /** Injected clock for deterministic timeout and waitedMs in tests. */
  now?: () => number;
}

export async function requestObservation(
  request: WatcherObserveRequest,
  deps: ObserveDeps,
): Promise<WatcherObservationResult> {
  const now = deps.now ?? Date.now;
  const timeoutMs = request.timeoutMs ?? (request.wait ? 120_000 : 10_000);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = (): void => controller.abort();
  deps.signal?.addEventListener("abort", onAbort, { once: true });
  // Bounds the wait even when the transport goes silent mid-observation.
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.max(1, deadline - now()),
  );

  const finish = (
    outcome: ObservationOutcome,
    observation: WatcherObservation | null,
    options: { supersedingGeneration?: number | null; message?: string | null } = {},
  ): WatcherObservationResult =>
    observationResult(observation, outcome, {
      waitedMs: now() - startedAt,
      maxEvidenceLines: request.maxEvidenceLines,
      ...options,
    });

  // Transport outcomes keep their own label; everything else is downgraded
  // when the completing observation cannot be trusted (contract §8).
  const completion = (
    outcome: ObservationOutcome,
    observation: WatcherObservation | null,
  ): WatcherObservationResult => {
    if (
      observation !== null &&
      outcome !== "timeout" &&
      outcome !== "disconnect" &&
      outcome !== "aborted" &&
      outcome !== "unknown"
    ) {
      if (observation.freshness === "stale") return finish("stale", observation);
      if (observation.freshness === "unknown") return finish("unknown", observation);
    }
    return finish(outcome, observation);
  };

  let last: WatcherObservation | null = null;
  try {
    let anchor: number | null = null;
    let latched: number | null = null;
    const afterGeneration = request.afterGeneration ?? null;

    for await (const observation of deps.port.open(controller.signal)) {
      if (now() >= deadline) return finish("timeout", last ?? observation);
      last = observation;
      if (request.wait) deps.onObservation?.(observation);
      else return completion("snapshot", observation);

      if (afterGeneration !== null) {
        // Fresh mode: wait for the first generation newer than the anchor,
        // then for that generation's terminal state.
        if (latched === null) {
          if (observation.status.generation <= afterGeneration) continue;
          latched = observation.status.generation;
        } else if (observation.status.generation > latched) {
          return finish("superseded", observation, {
            supersedingGeneration: observation.status.generation,
          });
        }
        if (isTerminal(observation.status.state)) return completion("terminal", observation);
        continue;
      }

      // Anchor mode: wait for the observed generation to reach terminal.
      if (anchor === null) {
        anchor = observation.status.generation;
        if (observation.status.state === "idle" && (observation.snapshot?.pending ?? 0) === 0) {
          return completion("noop", observation);
        }
        if (isTerminal(observation.status.state)) return completion("terminal", observation);
        continue;
      }

      if (observation.status.generation > anchor) {
        return finish("superseded", observation, {
          supersedingGeneration: observation.status.generation,
        });
      }
      if (isTerminal(observation.status.state)) return completion("terminal", observation);
    }

    // Stream ended without an abort from our side: the transport dropped.
    if (deps.signal?.aborted) return finish("aborted", last);
    if (timedOut) return finish("timeout", last);
    return finish("disconnect", last, { message: "watcher disconnected while observing" });
  } catch (error) {
    if (deps.signal?.aborted) return finish("aborted", last);
    if (timedOut) return finish("timeout", last);
    const message = error instanceof Error ? error.message : String(error);
    return finish(deps.classifyError(error), last, { message });
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

function isTerminal(state: WatcherExecutionState): boolean {
  return TERMINAL_STATES.has(state);
}
