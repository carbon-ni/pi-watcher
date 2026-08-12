export type WatcherExecutionState = "idle" | "running" | "passed" | "failed" | "cancelled";

export interface WatcherTarget {
  name: string;
  commands: string[];
}

export interface WatcherStatus {
  generation: number;
  state: WatcherExecutionState;
  trigger: string | null;
  commands: string[];
  durationMs: number | null;
  failures: string[];
}
