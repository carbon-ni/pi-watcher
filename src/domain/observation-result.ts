import type {
  WatcherCorrelatedSnapshot,
  WatcherFreshness,
  WatcherInstance,
  WatcherTaskOutcome,
} from "./capabilities.js";
import type { WatcherObservation, WatcherObservationSource } from "./observation.js";
import type { WatcherExecutionState } from "./watcher.js";

/**
 * Observation vocabulary (contract §7): one decision-oriented result for the
 * `watcher_observe` tool. Pure domain: no transport, no Pi. The tool never
 * triggers work; outcomes label what was observed (or why observation
 * stopped), and weaker guarantees are labeled, never equated with stronger
 * ones (contract §8).
 */

export type ObservationOutcome =
  /** wait=false: current state returned without waiting. */
  | "snapshot"
  /** wait=true: reached a terminal state (passed/failed/cancelled). */
  | "terminal"
  /** Idle watcher with no generation in flight and nothing pending. */
  | "noop"
  /** The generation being waited on was replaced by a newer run. */
  | "superseded"
  | "timeout"
  | "disconnect"
  | "aborted"
  /** Completing observation carries stale freshness; do not trust it. */
  | "stale"
  /** Malformed or unsupported server payload; see message. */
  | "unknown";

export interface WatcherObserveRequest {
  /** Wait for a terminal state (or a generation after `afterGeneration`). */
  wait: boolean;
  /** Only generations newer than this complete the wait (default: null). */
  afterGeneration?: number | null;
  /** Bounded wait budget; defaults differ for snapshot vs wait. */
  timeoutMs?: number;
  /** Max failure-evidence lines included (0 = none, default 40). */
  maxEvidenceLines?: number;
}

/** Server-side evidence cap mirrored from the legacy limits contract. */
export const SERVER_MAX_EVIDENCE_LINES = 40;

export interface WatcherObservationResult {
  outcome: ObservationOutcome;
  instance: WatcherInstance | null;
  generation: number | null;
  batchId: string | null;
  state: WatcherExecutionState | null;
  durationMs: number | null;
  trigger: string | null;
  freshness: WatcherFreshness;
  /** "polled" labels the weaker legacy guarantee (contract §8). */
  source: WatcherObservationSource;
  tasks: WatcherTaskOutcome[];
  pending: number | null;
  /** Bounded failure evidence tail; see truncated/evidenceLines. */
  failures: string[];
  /** True when the server cap or the requested tail cut evidence. */
  truncated: boolean;
  /** Number of evidence lines actually included. */
  evidenceLines: number;
  /** Copyable retrieval hint; only present when evidence is truncated. */
  nextAction: string | null;
  /** Newer generation that replaced the waited-on one (superseded only). */
  supersedingGeneration: number | null;
  waitedMs: number;
  /** Actionable detail for unknown/disconnect outcomes. */
  message: string | null;
}

export interface ObservationResultOptions {
  waitedMs?: number;
  supersedingGeneration?: number | null;
  message?: string | null;
  maxEvidenceLines?: number;
}

/**
 * Build a typed observation result from the completing observation (or null
 * when observation ended before any data) and the outcome. Pure and
 * deterministic: evidence bounding, truncation, and the retrieval hint are
 * decided here, never in the tool.
 */
export function observationResult(
  observation: WatcherObservation | null,
  outcome: ObservationOutcome,
  options: ObservationResultOptions = {},
): WatcherObservationResult {
  const maxLines = Math.max(0, options.maxEvidenceLines ?? SERVER_MAX_EVIDENCE_LINES);
  const rawFailures = observation?.status.failures ?? [];
  const failures = rawFailures.slice(0, maxLines);
  const truncated =
    rawFailures.length > maxLines || rawFailures.length >= SERVER_MAX_EVIDENCE_LINES;

  const state = observation?.status.state ?? null;
  const generation = observation?.status.generation ?? null;
  const failedTasks = (observation?.snapshot?.tasks ?? []).filter(
    (task) => task.state === "failed",
  );
  const nextAction =
    truncated && state === "failed" && generation !== null
      ? `watcher_output generation=${generation}${
          failedTasks.length === 1 ? ` task=${failedTasks[0]!.name}` : ""
        }`
      : null;

  return {
    outcome,
    instance: observation?.snapshot?.instance ?? null,
    generation,
    batchId: observation?.snapshot?.batchId ?? null,
    state,
    durationMs: observation?.status.durationMs ?? null,
    trigger: observation?.status.trigger ?? null,
    freshness: observation?.freshness ?? "unknown",
    source: observation?.source ?? "subscription",
    tasks: observation?.snapshot?.tasks ?? [],
    pending: observation?.snapshot?.pending ?? null,
    failures,
    truncated,
    evidenceLines: failures.length,
    nextAction,
    supersedingGeneration: options.supersedingGeneration ?? null,
    waitedMs: options.waitedMs ?? 0,
    message: options.message ?? null,
  };
}

/** Compact content projection used by tool content and error messages. */
export function formatObservation(result: WatcherObservationResult): string {
  const generation = result.generation === null ? "" : ` gen=${result.generation}`;
  const freshness = ` freshness=${result.freshness}`;
  const polled = result.source === "polled" ? " (polled)" : "";
  const waited = ` waited=${Math.round(result.waitedMs / 1_000)}s`;

  switch (result.outcome) {
    case "noop":
      return `NOOP${generation}${freshness} (nothing pending)${polled}`;
    case "superseded":
      return `SUPERSEDED${generation}${freshness} supersededBy=${result.supersedingGeneration}${polled}`;
    case "timeout":
      return `TIMEOUT${generation}${freshness}${waited}${polled}`;
    case "disconnect":
      return `DISCONNECTED${generation}${freshness}${polled}`;
    case "aborted":
      return `ABORTED${generation}${freshness}${polled}`;
    case "stale":
      return `STALE${generation}${freshness}${polled}`;
    case "unknown": {
      const message = result.message === null ? "" : ` message=${result.message}`;
      return `UNKNOWN${generation}${freshness}${message}${polled}`;
    }
    case "snapshot":
    case "terminal":
      return formatStateLine(result, generation, freshness, polled);
  }
}

function formatStateLine(
  result: WatcherObservationResult,
  generation: string,
  freshness: string,
  polled: string,
): string {
  const duration =
    (result.state === "passed" || result.state === "failed") && result.durationMs !== null
      ? ` duration=${result.durationMs}ms`
      : "";
  if (result.state === "failed") {
    const failedTasks = result.tasks.filter((task) => task.state === "failed");
    const failedLabel =
      failedTasks.length === 1
        ? ` task=${failedTasks[0]!.name}`
        : failedTasks.length > 1
          ? ` tasks=${failedTasks.length} failed`
          : "";
    const lines = result.failures.map((failure) => `  - ${failure}`).join("\n");
    const next = result.nextAction === null ? "" : `\nnext: ${result.nextAction}`;
    return `FAIL${generation}${freshness}${failedLabel}${duration}${polled}${
      lines ? `\n${lines}` : ""
    }${next}`;
  }
  const label = STATE_LABELS[result.state ?? "unknown"];
  return `${label}${generation}${freshness}${duration}${polled}`;
}

const STATE_LABELS: Record<WatcherExecutionState | "unknown", string> = {
  idle: "IDLE",
  running: "RUNNING",
  passed: "PASS",
  failed: "FAIL",
  cancelled: "CANCELLED",
  unknown: "UNKNOWN",
};

/** Compact progress line for in-flight observations (rate-bounded by tool). */
export function formatObservationProgress(observation: WatcherObservation): string {
  const generation = ` gen=${observation.status.generation}`;
  const freshness = ` freshness=${observation.freshness}`;
  const polled = observation.source === "polled" ? " (polled)" : "";
  const label = STATE_LABELS[observation.status.state] ?? "UNKNOWN";
  return `${label}${generation}${freshness}${polled}`;
}

export type { WatcherCorrelatedSnapshot, WatcherTaskOutcome };
