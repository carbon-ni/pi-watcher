import type { WatcherObservation } from "./observation.js";
import type { WatcherStatus } from "./watcher.js";

/**
 * Failure delivery policy (contract §8): one deterministic authority decides
 * which connected session receives one terminal fresh failure, and each
 * failure is delivered at most once across all sessions sharing a watcher.
 *
 * Gates (all must hold): the status is a terminal failure, the agent is idle,
 * this session owns the responder, the observation is fresh (not stale), the
 * session is not already observing/verifying the generation, and the atomic
 * cross-session delivery claim wins. The claim is the single source of truth
 * for at-most-once; observation-only waits never claim anything.
 */

export interface FailureNotifierDeps {
  /** Whether this session already observed/verified the generation (tools). */
  isHandled: (key: string) => boolean;
  /** Atomic cross-session claim; false when another session already delivered. */
  claimDelivery: (key: string) => Promise<boolean>;
}

export function createFailureNotifier(
  sessionId: string,
  sendFailure: (status: WatcherStatus) => void,
  deps: FailureNotifierDeps,
) {
  let sentKey: string | undefined;

  return async (
    observation: WatcherObservation,
    isAgentIdle: boolean,
    responderSessionId: string | null,
  ): Promise<boolean> => {
    const status = observation.status;
    if (status.state !== "failed" || !isAgentIdle) return false;
    if (responderSessionId !== sessionId) return false;
    // Only terminal FRESH failures trigger follow-up (contract §8).
    if (observation.freshness !== "current") return false;

    const key = failureDeliveryKey(observation);
    if (deps.isHandled(failureEngagementKey(observation))) return false;
    if (sentKey === key) return false;

    const claimed = await deps.claimDelivery(key);
    if (!claimed) return false;

    sentKey = key;
    sendFailure(status);
    return true;
  };
}

/**
 * Extract the failed task name from a status failure entry for actionable
 * follow-up hints. Failure entries are `"<task>: <error>"`; a malformed
 * entry returns null so the hint stays conservative.
 */
export function firstFailedTask(failures: readonly string[]): string | null {
  for (const failure of failures) {
    const separator = failure.indexOf(": ");
    if (separator > 0) return failure.slice(0, separator);
  }
  return null;
}

/**
 * Ledger key for at-most-once delivery. Subscription observations carry the
 * watcher instance identity, so instance + generation uniquely identify the
 * failure across reconnects and restarts. Legacy polled observations have no
 * instance identity, so a failure signature is added: a restarted watcher may
 * reuse generation numbers, and only genuinely identical evidence dedupes.
 */
export function failureDeliveryKey(observation: WatcherObservation): string {
  return failureDeliveryKeyParts(
    observation.snapshot?.instance.token ?? null,
    observation.status.generation,
    observation.status.failures,
  );
}

export function failureDeliveryKeyParts(
  instanceToken: string | null,
  generation: number,
  failures: string[],
): string {
  if (instanceToken !== null && instanceToken.length > 0) {
    return `${instanceToken}:${generation}`;
  }
  return `legacy:${generation}:${failureSignature(failures)}`;
}

/**
 * Engagement key for the redundant-follow-up guard. No failure signature:
 * the tool only holds bounded evidence, and the guard must match whatever the
 * observation carries. On the legacy path this intentionally keys by
 * generation alone; a missed follow-up after a watcher restart is the
 * conservative trade-off against a guaranteed duplicate on every failed
 * verification.
 */
export function failureEngagementKey(observation: WatcherObservation): string {
  return failureEngagementKeyParts(
    observation.snapshot?.instance.token ?? null,
    observation.status.generation,
  );
}

export function failureEngagementKeyParts(
  instanceToken: string | null,
  generation: number,
): string {
  if (instanceToken !== null && instanceToken.length > 0) {
    return `${instanceToken}:${generation}`;
  }
  return `legacy:${generation}`;
}

/** Deterministic short signature of the failure evidence (FNV-1a). */
function failureSignature(failures: string[]): string {
  const joined = failures.join("\u0000");
  let hash = 2166136261;
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 12);
}
