import type { WatcherCorrelatedSnapshot, WatcherFreshness } from "./capabilities.js";
import type { WatcherStatus } from "./watcher.js";

/**
 * Normalized lifecycle snapshot consumed by the status bar and failure
 * notifier (contract §7): one observation per transport event, carrying the
 * transport-local monotonic sequence, the decoded status, the guarantee
 * source, and the freshness tier. Transport callbacks never reach consumers.
 *
 * `snapshot` carries the full correlated payload when the transport
 * negotiated it (contract §2); it is null on the legacy polled path where no
 * correlation fields exist.
 */
export type WatcherObservationSource = "subscription" | "polled";

export interface WatcherObservation {
  /** Monotonic per transport stream; duplicate/lower sequences are dropped. */
  sequence: number;
  status: WatcherStatus;
  /** "polled" marks the legacy fallback with weaker freshness (contract §8). */
  source: WatcherObservationSource;
  freshness: WatcherFreshness;
  /** Correlated snapshot (instance/batch/tasks/pending) or null on polled. */
  snapshot: WatcherCorrelatedSnapshot | null;
}

/**
 * Policy: forward only strictly newer sequences. A first observation always
 * forwards; reordered or duplicated deliveries never re-trigger UI or failure
 * updates.
 */
export function shouldForwardObservation(
  current: WatcherObservation | null,
  next: WatcherObservation,
): boolean {
  return current === null || next.sequence > current.sequence;
}

/** Footer suffix that makes weaker polling guarantees visible to the user. */
export function observationFooterSuffix(source: WatcherObservationSource): string {
  return source === "polled" ? " (polled)" : "";
}
