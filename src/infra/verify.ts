import {
  FunzzyDisconnectError,
  FunzzyRequestTimeoutError,
  FunzzyRpcError,
  requestRunAtomic,
} from "./client.js";
import type { queryStatus, requestRun } from "./client.js";
import { snapshotToStatus } from "../domain/capabilities.js";
import { SupersededRunError, waitForRun } from "../application/stable-run.js";
import type { AtomicRunOutcome, AtomicRunRequest, VerifyPort } from "../application/verify.js";

/**
 * Verification ports (contract §4): transport adapters for one run-and-await.
 * The atomic port speaks the agreed additive contract (fixtures in
 * `src/domain/fixtures/`); the legacy port keeps the polling path, fail-closed
 * and labeled weaker. All outcomes are explicit; no socket leaks upward.
 */

/**
 * Atomic port over the agreed additive `run {target, wait:true}` contract.
 * `expectedInstanceToken` comes from capability negotiation: a snapshot from a
 * different instance means the watcher restarted mid-run.
 */
export function createAtomicVerifyPort(
  socketPath: string,
  expectedInstanceToken: string | null,
  schemaVersion = 1,
): VerifyPort {
  return {
    async runAndAwait(request: AtomicRunRequest): Promise<AtomicRunOutcome> {
      try {
        const result = await requestRunAtomic(
          socketPath,
          request.target,
          request.timeoutMs,
          (runId) => request.onSchedule?.(runId),
          request.signal,
          request.sequential,
          schemaVersion,
        );
        if (request.signal?.aborted) return { kind: "aborted" };
        if (
          expectedInstanceToken !== null &&
          result.snapshot.instance.token !== expectedInstanceToken
        ) {
          return { kind: "restart", generation: result.runId };
        }
        return {
          kind: "terminal",
          generation: result.runId,
          status: snapshotToStatus(result.snapshot),
          snapshot: result.snapshot,
          source: "subscription",
        };
      } catch (error) {
        if (request.signal?.aborted) return { kind: "aborted" };
        if (error instanceof FunzzyRpcError) {
          if (error.code === -32001) {
            const data =
              typeof error.data === "object" && error.data !== null
                ? (error.data as Record<string, unknown>)
                : {};
            const supersedingRunId = Number(data["supersedingRunId"] ?? 0);
            return { kind: "superseded", generation: null, supersedingRunId };
          }
          if (error.code === -32002) return { kind: "cancelled", generation: null };
        }
        if (error instanceof FunzzyRequestTimeoutError)
          return { kind: "timeout", generation: null };
        if (error instanceof FunzzyDisconnectError) return { kind: "disconnect", generation: null };
        return {
          kind: "unknown",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export interface LegacyVerifyPortOptions {
  socketPath: string;
  pollIntervalMs: number;
  requestRun: typeof requestRun;
  queryStatus: typeof queryStatus;
}

/**
 * Legacy port: request then poll the single generation to a terminal state.
 * No correlation fields exist, so the application labels outcomes `polled`.
 * Supersede handling stays explicit; retry policy lives in the use case.
 */
export function createLegacyVerifyPort(options: LegacyVerifyPortOptions): VerifyPort {
  return {
    async runAndAwait(request: AtomicRunRequest): Promise<AtomicRunOutcome> {
      try {
        const runId = await options.requestRun(options.socketPath, request.target);
        request.onSchedule?.(runId);
        const status = await waitForRun(
          runId,
          request.timeoutMs,
          async () => {
            if (request.signal?.aborted) throw new Error("Funzzy verification was cancelled");
            return options.queryStatus(options.socketPath);
          },
          options.pollIntervalMs,
        );
        return {
          kind: "terminal",
          generation: status.generation,
          status,
          snapshot: null,
          source: "polled",
        };
      } catch (error) {
        if (request.signal?.aborted) return { kind: "aborted" };
        if (error instanceof SupersededRunError) {
          return {
            kind: "superseded",
            generation: error.runId,
            supersedingRunId: error.supersedingRunId,
          };
        }
        if (error instanceof FunzzyDisconnectError) return { kind: "disconnect", generation: null };
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("timed out")) return { kind: "timeout", generation: null };
        if (message.includes("cancelled")) return { kind: "aborted" };
        return { kind: "unknown", message };
      }
    },
  };
}
