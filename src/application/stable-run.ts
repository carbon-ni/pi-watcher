import type { WatcherStatus } from "../domain/watcher.js";

export class SupersededRunError extends Error {
  constructor(
    readonly runId: number,
    readonly supersedingRunId: number,
  ) {
    super(`Funzzy run ${runId} was superseded by run ${supersedingRunId}`);
  }
}

export interface StableRunOptions {
  timeoutMs: number;
  request: () => Promise<number>;
  readStatus: () => Promise<WatcherStatus>;
  isWorktreeCurrent: () => Promise<boolean>;
  pollIntervalMs?: number;
}

export async function requestStableRun(options: StableRunOptions): Promise<WatcherStatus> {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() <= deadline) {
    const runId = await options.request();
    try {
      return await waitForRun(
        runId,
        Math.max(1, deadline - Date.now()),
        options.readStatus,
        options.pollIntervalMs,
      );
    } catch (error) {
      if (!(error instanceof SupersededRunError)) throw error;
      if (!(await options.isWorktreeCurrent())) {
        throw new Error("STALE: worktree changed while Funzzy verification was running");
      }
    }
  }

  throw new Error(`Funzzy verification timed out after ${options.timeoutMs}ms`);
}

export async function waitForRun(
  runId: number,
  timeoutMs: number,
  readStatus: () => Promise<WatcherStatus>,
  pollIntervalMs = 100,
  onUpdate?: (status: WatcherStatus) => void,
  updateIntervalMs = 5_000,
): Promise<WatcherStatus> {
  const deadline = Date.now() + timeoutMs;
  let nextUpdateAt = 0;
  while (Date.now() <= deadline) {
    const status = await readStatus();
    if (status.generation === runId && status.state !== "running") return status;
    if (status.generation === runId && Date.now() >= nextUpdateAt) {
      onUpdate?.(status);
      nextUpdateAt = Date.now() + updateIntervalMs;
    }
    if (status.generation > runId) {
      throw new SupersededRunError(runId, status.generation);
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Funzzy run ${runId} timed out after ${timeoutMs}ms`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
