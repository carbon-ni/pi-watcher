import { expectObject, readRequiredBoolean, readRequiredNumber } from "./protocol.js";

export { WatcherProtocolError } from "./protocol.js";

/**
 * Cancellation vocabulary (contract §6, §10): compare-and-cancel for an exact
 * generation plus instance identity, so a stale request can never affect a
 * replacement or newer run. Pure domain: decoding validates the wire shape,
 * formatting reports graceful versus escalated/unknown cleanup, and the
 * outcome taxonomy is decided here, never in sockets or Pi handlers.
 */

export type CancellationOutcome =
  /** Server confirmed the exact generation was cancelled gracefully. */
  | "cancelled"
  /** Nothing matched the exact generation (already terminal or superseded). */
  | "not-running"
  /** The server had to force cleanup instead of a graceful stop. */
  | "escalated"
  /** No acknowledgement arrived within the bounded wait. */
  | "timeout"
  | "disconnect"
  | "unknown";

export interface WatcherCancelRequest {
  /** Exact generation to cancel; compare-and-cancel on the server side. */
  generation: number;
  /** Bounded acknowledgement wait in milliseconds. */
  timeoutMs?: number;
}

export interface WatcherCancelResult {
  outcome: CancellationOutcome;
  generation: number;
  /** Actionable detail for unknown outcomes. */
  message: string | null;
}

/**
 * Decode a `cancel` method result from `unknown`.
 *
 * Wire shape is the agreed additive contract (`src/domain/fixtures/cancel.json`,
 * mirrored by Rust protocol tests): `{ cancelled: boolean, generation: number }`.
 * Escalation arrives as RPC error -32021 and is mapped by the cancel port.
 */
export function decodeWatcherCancel(value: unknown): { cancelled: boolean; generation: number } {
  const object = expectObject(value, "cancel response");
  const cancelled = readRequiredBoolean(object, "cancelled", "cancel response");
  const generation = readRequiredNumber(object, "generation", "cancel response");
  return { cancelled, generation };
}

/** Compact content projection used by tool content and error messages. */
export function formatCancellation(result: WatcherCancelResult): string {
  const generation = ` gen=${result.generation}`;
  const message =
    result.outcome === "unknown" && result.message !== null ? ` message=${result.message}` : "";
  return `CANCEL${generation} ${result.outcome}${message}`;
}

/**
 * Compact cleanup report appended to verify results after an abort:
 * graceful, escalated, or unknown collapse into three words; a no-op (the
 * generation was already done or superseded) reports none.
 */
export function cancellationReport(result: WatcherCancelResult | null): string {
  if (result === null) return "cleanup=none";
  switch (result.outcome) {
    case "cancelled":
      return "cleanup=cancelled";
    case "escalated":
      return "cleanup=escalated";
    case "not-running":
      return "cleanup=none";
    default:
      return "cleanup=unknown";
  }
}
