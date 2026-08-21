import type { WatcherTaskOutcome } from "./capabilities.js";

/**
 * Human-only projection of immutable terminal task snapshots. The input order
 * is the server's configured declaration order; never sort by name, duration,
 * or terminal-event arrival. Legacy/polled observations have no task snapshots
 * and therefore intentionally render no rows.
 */
export function formatJobTimings(tasks: WatcherTaskOutcome[]): string {
  if (tasks.length === 0) return "";
  const rows = tasks
    .map((task) => {
      const identity = task.id === task.name ? task.name : `[${task.id}] ${task.name}`;
      const duration = task.durationMs === null ? "-" : formatDuration(task.durationMs);
      return `  ${identity} ${task.state} ${duration}`;
    })
    .join("\n");
  return `\njobs:\n  JOB RESULT DURATION\n${rows}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 3_600_000)
    return `${Math.floor(durationMs / 60_000)}m${Math.floor((durationMs % 60_000) / 1_000)}`;
  return `${Math.floor(durationMs / 3_600_000)}h${Math.floor((durationMs % 3_600_000) / 60_000)}m`;
}
