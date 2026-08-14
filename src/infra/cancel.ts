import type { CancelPort } from "../application/cancel.js";
import type { CancellationOutcome, WatcherCancelRequest } from "../domain/cancel.js";
import {
  FunzzyDisconnectError,
  FunzzyRequestTimeoutError,
  FunzzyRpcError,
  requestCancel,
} from "./client.js";

/**
 * Cancel port (contract §6): transport adapter for one compare-and-cancel.
 * The wire request carries the exact generation plus the negotiated instance
 * token, so a stale request is a safe no-op on a replacement or newer run.
 * Every transport failure maps to an explicit outcome; no socket leaks up.
 */

export interface CancelPortOptions {
  socketPath: string;
  /** Negotiated instance token; empty on the legacy profile (no identity). */
  instanceToken: string;
  requestCancel?: typeof requestCancel;
}

export function createCancelPort(options: CancelPortOptions): CancelPort {
  const requestCancelFn = options.requestCancel ?? requestCancel;
  return {
    async cancel(request: WatcherCancelRequest): Promise<{
      outcome: CancellationOutcome;
      message: string | null;
    }> {
      try {
        const result = await requestCancelFn(
          options.socketPath,
          request.generation,
          options.instanceToken,
          request.timeoutMs ?? 3_000,
        );
        return { outcome: result.cancelled ? "cancelled" : "not-running", message: null };
      } catch (error) {
        if (error instanceof FunzzyRpcError && error.code === -32021) {
          return { outcome: "escalated", message: null };
        }
        if (error instanceof FunzzyDisconnectError) {
          return { outcome: "disconnect", message: error.message };
        }
        if (error instanceof FunzzyRequestTimeoutError) {
          return { outcome: "timeout", message: error.message };
        }
        return {
          outcome: "unknown",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
