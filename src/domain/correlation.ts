/**
 * Edit-to-batch correlation policy (contract §9): evidence of inclusion, never
 * proof that an edit caused an event. Pure domain: path normalization cannot
 * leak unrelated workspace paths, checkpoints stay bounded and session scoped,
 * and the classifier labels exact overlap, no overlap, incomplete evidence,
 * and unknown — without ever upgrading a verification's freshness contract.
 */

export type CorrelationClass = "exact-overlap" | "no-overlap" | "incomplete" | "unknown";

export interface EditCheckpoint {
  /** Watcher instance the checkpoint was recorded under. */
  instanceToken: string | null;
  /** Normalized relative paths edited by this session (bounded). */
  paths: string[];
  /** Last recording time, for expiry. */
  at: number;
}

export const CORRELATION_CHECKPOINT_TTL_MS = 10 * 60_000;
export const CORRELATION_CHECKPOINT_MAX_PATHS = 50;

export interface CorrelationResult {
  class: CorrelationClass;
  /** True when the checkpoint belonged to a previous watcher instance. */
  clearedOnInstanceChange: boolean;
}

/**
 * Normalize edited paths against the trusted project root: absolute paths
 * under the root become relative, relative paths are kept (dot-prefix and
 * duplicate stripped), and anything outside the root — including traversal
 * segments — is dropped so unrelated workspace paths can never leak.
 */
export function normalizeEditPaths(paths: string[], root: string): string[] {
  const normalizedRoot = root.replace(/\/+$/, "");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const path = raw.trim();
    if (path.length === 0) continue;

    let relative: string;
    if (path.startsWith("/")) {
      const prefix = `${normalizedRoot}/`;
      if (!path.startsWith(prefix)) continue;
      relative = path.slice(normalizedRoot.length).replace(/^\/+/, "");
    } else {
      relative = path.replace(/^\.\//, "");
    }

    if (relative.length === 0) continue;
    if (relative.split("/").includes("..")) continue;
    if (seen.has(relative)) continue;
    seen.add(relative);
    result.push(relative);
  }

  return result.sort();
}

/**
 * Merge new edited paths into the session checkpoint: live checkpoints from
 * the same watcher instance accumulate (bounded), while a new instance or an
 * expired checkpoint starts fresh. Deterministic and bounded.
 */
export function recordEditCheckpoint(
  current: EditCheckpoint | null,
  paths: string[],
  instanceToken: string | null,
  now: number,
  maxPaths = CORRELATION_CHECKPOINT_MAX_PATHS,
  ttlMs = CORRELATION_CHECKPOINT_TTL_MS,
): EditCheckpoint {
  const live =
    current !== null && current.instanceToken === instanceToken && now - current.at < ttlMs;
  const merged = live ? [...current.paths, ...paths] : [...paths];
  const unique = [...new Set(merged)];
  return {
    instanceToken,
    paths: unique.slice(-maxPaths),
    at: now,
  };
}

/**
 * Classify whether a watcher batch includes this session's edits. Unknown
 * without a checkpoint (no evidence), incomplete when the batch carries no
 * paths (cannot verify), and exact/no overlap otherwise. A checkpoint from a
 * different watcher instance is stale: report unknown and signal clearing.
 */
export function classifyCorrelation(
  checkpoint: EditCheckpoint | null,
  instanceToken: string | null,
  batchPaths: string[],
  root: string,
): CorrelationResult {
  if (checkpoint === null || checkpoint.paths.length === 0) {
    return { class: "unknown", clearedOnInstanceChange: false };
  }
  if (checkpoint.instanceToken !== instanceToken) {
    return { class: "unknown", clearedOnInstanceChange: true };
  }

  const normalizedBatch = normalizeEditPaths(batchPaths, root);
  if (normalizedBatch.length === 0) {
    return { class: "incomplete", clearedOnInstanceChange: false };
  }

  const overlap = checkpoint.paths.some((path) => normalizedBatch.includes(path));
  return {
    class: overlap ? "exact-overlap" : "no-overlap",
    clearedOnInstanceChange: false,
  };
}
