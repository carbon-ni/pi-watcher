/**
 * Lazy-registration gate for the watcher surface (pi-watcher/AGENTS.md).
 *
 * The gate is intentionally presence-only: it never parses or validates the
 * contract file. Malformed configurations or a missing `on.socket` still open
 * the gate so the existing tool-call-time config errors stay reachable.
 */

/** Which funzzy contract files exist in the project root. */
export interface WatcherConfigPresence {
  watchYaml: boolean;
  watchYml: boolean;
}

/** Canonical watcher tool names exposed to Pi (public compatibility surface). */
export const WATCHER_TOOL_NAMES = [
  "watcher_status",
  "watcher_targets",
  "watcher_observe",
  "watcher_output",
  "watcher_cancel",
  "watcher_verify",
] as const;

/** Decide whether the watcher surface may be exposed: any contract file present. */
export function exposesWatcherTools(presence: WatcherConfigPresence): boolean {
  return presence.watchYaml || presence.watchYml;
}
