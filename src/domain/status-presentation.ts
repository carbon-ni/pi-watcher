import type { WatcherStatus } from "./watcher.js";

export function renderWatcherFooter(status: WatcherStatus): string {
  const duration = status.durationMs === null ? "" : ` ${status.durationMs}ms`;
  return `watcher: ${status.state} #${status.generation}${duration}`;
}
