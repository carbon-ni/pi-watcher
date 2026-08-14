/**
 * Automatic ownership activity policy (contract §8): who may own an automatic
 * follow-up, kept separate from persistence.
 *
 * The policy is conservative and explicit: an automatic owner is the session
 * with the most recent worktree-activity tool call (`recordsAgentActivity`:
 * bash/edit/write only). Automatic ownership expires after `AUTOMATIC_OWNER_TTL_MS`
 * without activity, so a dead or abandoned session cannot block delivery
 * forever. Pinned ownership is explicit user intent and never expires.
 * Persistence (the responder files) lives in infra; this module only decides.
 */

export const AUTOMATIC_OWNER_TTL_MS = 30 * 60_000;

export function isAutomaticOwnerExpired(updatedAt: number, now: number): boolean {
  return now - updatedAt > AUTOMATIC_OWNER_TTL_MS;
}
