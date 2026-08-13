import {
  decodeWatcherCorrelatedSnapshot,
  type WatcherCorrelatedSnapshot,
  type WatcherFreshness,
  type WatcherInstance,
} from "./capabilities.js";
import { expectObject, readRequiredNumber, WatcherProtocolError } from "./protocol.js";

export { WatcherProtocolError } from "./protocol.js";
import type { WatcherExecutionState, WatcherTarget } from "./watcher.js";
import type { WatcherObservationSource } from "./observation.js";

/**
 * Verification vocabulary (contract §4, §5): exact target selection, atomic
 * run-and-await outcomes, and the acceptance reasons a tool may report.
 * Pure domain: selection never picks work implicitly, retries are bounded,
 * and weaker polling guarantees are labeled, never equated with atomic ones.
 */

export type WatcherTargetMatch = "exact" | "substring";

export interface WatcherVerifyRequest {
  /** Exact stable target name/ID by default; substring only when opted in. */
  target: string;
  matchMode?: WatcherTargetMatch;
  timeoutMs?: number;
}

export type VerificationReason =
  | "passed"
  | "failed"
  | "cancelled"
  | "missing-target"
  | "ambiguous-target"
  | "superseded"
  | "timeout"
  | "disconnect"
  | "restart"
  | "stale"
  | "aborted"
  | "unknown";

export type TargetSelection =
  | { kind: "selected"; target: WatcherTarget }
  | { kind: "missing"; candidates: string[] }
  | { kind: "ambiguous"; candidates: string[] };

const MAX_CANDIDATES = 5;

/**
 * Exact selection by default; substring matching only when explicitly opted
 * in. Ambiguity always yields candidates, never a silent pick (contract §5).
 */
export function selectTarget(
  targets: WatcherTarget[],
  requested: string,
  matchMode: WatcherTargetMatch = "exact",
): TargetSelection {
  if (matchMode === "exact") {
    const exact = targets.filter((target) => target.name === requested);
    if (exact.length === 1) return { kind: "selected", target: exact[0]! };
    return { kind: "missing", candidates: substringCandidates(targets, requested) };
  }

  const matches = targets.filter((target) => target.name.includes(requested));
  if (matches.length === 1) return { kind: "selected", target: matches[0]! };
  if (matches.length > 1) {
    return { kind: "ambiguous", candidates: matches.slice(0, MAX_CANDIDATES).map((t) => t.name) };
  }
  return { kind: "missing", candidates: [] };
}

function substringCandidates(targets: WatcherTarget[], requested: string): string[] {
  return targets
    .filter((target) => target.name.includes(requested))
    .slice(0, MAX_CANDIDATES)
    .map((target) => target.name);
}

/** One terminal verdict for a verified run, with typed evidence. */
export interface WatcherVerification {
  reason: VerificationReason;
  target: string;
  matchMode: WatcherTargetMatch;
  /** Null when the transport could not identify the watcher instance. */
  instance: WatcherInstance | null;
  generation: number | null;
  /** "polled" labels the weaker legacy guarantee (contract §8). */
  freshness: WatcherFreshness | "polled";
  source: WatcherObservationSource;
  /** Fingerprint after verification; matches the before-fingerprint on green. */
  fingerprint: string;
  fingerprintBefore: string;
  state: WatcherExecutionState | null;
  durationMs: number | null;
  /** Bounded failure evidence (see boundEvidence). */
  failures: string[];
  pending: number | null;
  supersedingRunId: number | null;
  attemptCount: number;
}

/** Evidence bound: never more than 40 lines nor 4000 chars reach a tool. */
export function boundEvidence(failures: string[], maxLines = 40, maxChars = 4_000): string[] {
  const bounded: string[] = [];
  let chars = 0;
  for (const failure of failures) {
    if (bounded.length >= maxLines) break;
    const line = failure.length > maxChars ? `${failure.slice(0, maxChars)}…` : failure;
    if (chars + line.length > maxChars && bounded.length > 0) break;
    bounded.push(line);
    chars += line.length;
    if (chars >= maxChars) break;
  }
  return bounded;
}

/** Compact content projection used by tool content and error messages. */
export function formatVerification(verification: WatcherVerification): string {
  const target = ` target=${verification.target}`;
  const generation = verification.generation === null ? "" : ` gen=${verification.generation}`;
  if (verification.reason === "passed") {
    const duration =
      verification.durationMs === null ? "" : ` duration=${verification.durationMs}ms`;
    return `PASS${generation}${target}${duration} fingerprint=${verification.fingerprint.slice(0, 12)}`;
  }
  if (verification.reason === "failed") {
    const failures = verification.failures
      .slice(0, 5)
      .map((failure) => `- ${failure}`)
      .join("\n");
    const summary = `FAIL${generation}${target} failures=${verification.failures.length}`;
    return failures ? `${summary}\n${failures}` : summary;
  }
  return `${verification.reason.toUpperCase()}${generation}${target}`;
}

/**
 * Decode an atomic `run` result from `unknown`.
 *
 * Wire shape is the agreed additive contract
 * (`src/domain/fixtures/atomic-run.json`): the requested generation plus its
 * terminal correlated snapshot, produced by a single server-side run-and-await.
 */
export interface AtomicRunResult {
  runId: number;
  snapshot: WatcherCorrelatedSnapshot;
}

export function decodeAtomicRunResult(value: unknown): AtomicRunResult {
  const object = expectObject(value, "run response");
  const runId = readRequiredNumber(object, "runId", "run response");
  if (!("snapshot" in object)) {
    throw new WatcherProtocolError(`Funzzy run response: "snapshot" is required`);
  }
  const snapshot = decodeWatcherCorrelatedSnapshot(object["snapshot"]);
  return { runId, snapshot };
}
