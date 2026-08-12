import type { WatcherExecutionState, WatcherStatus } from "./watcher.js";

export type WatcherStatusColor = "success" | "error" | "accent" | "muted" | "warning";

export const WATCHER_WIDGET_OPTIONS = { placement: "belowEditor" } as const;

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

export function rightAlignWatcherText(text: string, width: number): string {
  if (width <= 0) return "";

  return text.slice(0, width).padStart(width);
}

export function renderWatcherFooter(status: WatcherStatus): string {
  const duration = status.durationMs === null ? "" : ` ${status.durationMs}ms`;
  return `watcher: ${status.state} #${status.generation}${duration}`;
}
