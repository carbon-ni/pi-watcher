import type { WatcherExecutionState, WatcherStatus } from "./watcher.js";

export type WatcherStatusColor = "success" | "error" | "accent" | "muted" | "warning";

const STATUS_COLORS: Record<WatcherExecutionState, WatcherStatusColor> = {
  passed: "success",
  failed: "error",
  running: "accent",
  idle: "muted",
  cancelled: "warning",
};

export function watcherStatusColor(state: WatcherExecutionState): WatcherStatusColor {
  return STATUS_COLORS[state];
}

export function renderWatcherFooter(status: WatcherStatus): string {
  const duration = status.durationMs === null ? "" : ` ${status.durationMs}ms`;
  return `watcher: ${status.state} #${status.generation}${duration}`;
}
