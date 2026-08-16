import type {
  CancellationOutcome,
  WatcherCancelRequest,
  WatcherCancelResult,
} from "../domain/cancel.js";

/**
 * Cancellation use case (contract §6): one bounded compare-and-cancel over an
 * injected port. This module owns the result shaping and the bounded
 * acknowledgement wait; the port owns transport. Nothing here touches sockets
 * or Pi APIs, and observation-only aborts never reach this use case.
 */

export interface CancelPort {
  /** Send the compare-and-cancel; resolves with the transport outcome. */
  cancel(request: WatcherCancelRequest): Promise<{
    outcome: CancellationOutcome;
    message: string | null;
  }>;
}

export interface CancelDeps {
  port: CancelPort;
}

export async function requestCancellation(
  request: WatcherCancelRequest,
  deps: CancelDeps,
): Promise<WatcherCancelResult> {
  const portResult = await deps.port.cancel({
    generation: request.generation,
    timeoutMs: request.timeoutMs ?? 3_000,
  });
  return {
    outcome: portResult.outcome,
    generation: request.generation,
    message: portResult.message,
  };
}
