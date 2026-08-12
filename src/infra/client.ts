import { createConnection } from "node:net";

import type { WatcherStatus, WatcherTarget } from "../domain/watcher.js";

export type {
  WatcherStatus as FunzzyStatus,
  WatcherTarget as FunzzyTarget,
} from "../domain/watcher.js";
type FunzzyStatus = WatcherStatus;
type FunzzyTarget = WatcherTarget;

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface ControlResponse<T> {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: T;
  error?: RpcError;
}

export function queryStatus(socketPath: string, timeoutMs = 1_000): Promise<FunzzyStatus> {
  return sendRequest<FunzzyStatus>(
    socketPath,
    { jsonrpc: "2.0", id: "status", method: "status" },
    timeoutMs,
    true,
  );
}

export function listTargets(socketPath: string, timeoutMs = 1_000): Promise<FunzzyTarget[]> {
  return sendRequest<FunzzyTarget[]>(
    socketPath,
    { jsonrpc: "2.0", id: "targets", method: "targets" },
    timeoutMs,
  );
}

export async function requestRun(
  socketPath: string,
  target: string,
  timeoutMs = 1_000,
): Promise<number> {
  const response = await sendRequest<{ runId: number }>(
    socketPath,
    { jsonrpc: "2.0", id: "run", method: "run", params: { target } },
    timeoutMs,
  );
  return response.runId;
}

async function sendRequest<T>(
  socketPath: string,
  request: object,
  timeoutMs: number,
  retryInterrupted = false,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastConnectionError: Error | undefined;
  let retries = 0;

  while (Date.now() < deadline) {
    try {
      const result = await sendRequestOnce<T>(
        socketPath,
        request,
        Math.max(1, deadline - Date.now()),
        retryInterrupted,
      );
      if (retries > 0) debugLog(`connected to ${socketPath} after ${retries} retries`);
      return result;
    } catch (error) {
      if (!(error instanceof RetryableRequestError)) throw error;
      retries += 1;
      lastConnectionError = error.cause;
      debugLog(`retry ${retries} for ${socketPath}: ${error.cause.message}`);
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }

  const reason = lastConnectionError ? `: ${lastConnectionError.message}` : "";
  debugLog(`connection failed for ${socketPath} after ${retries} retries${reason}`);
  throw new Error(`Funzzy unavailable after ${timeoutMs}ms${reason}`);
}

function sendRequestOnce<T>(
  socketPath: string,
  request: object,
  timeoutMs: number,
  retryInterrupted: boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;
    let connected = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeoutMs, () =>
      fail(new Error(`Funzzy request timed out after ${timeoutMs}ms`)),
    );
    socket.once("error", (error) => {
      if (!connected && isRetryableSocketError(error)) {
        fail(new RetryableRequestError(error));
        return;
      }
      if (connected && retryInterrupted && isRetryableSocketError(error)) {
        fail(new RetryableRequestError(error));
        return;
      }
      fail(error);
    });
    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.length > 65_536) {
        fail(new Error("Funzzy response exceeded 64KB"));
        return;
      }

      const newline = response.indexOf("\n");
      if (newline < 0 || settled) return;

      try {
        const parsed = JSON.parse(response.slice(0, newline)) as ControlResponse<T>;
        if (parsed.jsonrpc !== "2.0") {
          throw new Error(`Unsupported Funzzy JSON-RPC version: ${parsed.jsonrpc}`);
        }
        if (parsed.error) throw new Error(formatRpcError(parsed.error));
        if (parsed.result === undefined) throw new Error("Funzzy response has no result");
        settled = true;
        socket.end();
        resolve(parsed.result);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("end", () => {
      if (settled) return;
      const error = new Error("Funzzy closed the socket without a complete response");
      fail(retryInterrupted ? new RetryableRequestError(error) : error);
    });
  });
}

function formatRpcError(error: RpcError): string {
  if (error.data === undefined) return `Funzzy RPC error ${error.code}: ${error.message}`;
  const data = typeof error.data === "string" ? error.data : JSON.stringify(error.data);
  return `Funzzy RPC error ${error.code}: ${error.message} (${data})`;
}

class RetryableRequestError extends Error {
  constructor(override readonly cause: Error) {
    super(cause.message);
  }
}

function isRetryableSocketError(error: Error): boolean {
  if (!("code" in error)) return false;
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(String(error.code));
}

export function formatStatus(status: FunzzyStatus): string {
  const generation = `gen=${status.generation}`;
  const tests = status.commands.length > 0 ? ` tests=${status.commands.join(" && ")}` : "";
  const trigger = status.trigger ? ` trigger=${status.trigger}` : "";

  if (status.state === "passed") {
    const duration = status.durationMs === null ? "" : ` duration=${status.durationMs}ms`;
    return `PASS ${generation}${tests}${duration}${trigger}`;
  }

  if (status.state === "failed") {
    const failures = status.failures
      .slice(0, 5)
      .map((failure) => `- ${failure}`)
      .join("\n");
    const summary = `FAIL ${generation} failures=${status.failures.length}${tests}${trigger}`;
    return failures ? `${summary}\n${failures}` : summary;
  }

  return `${status.state.toUpperCase()} ${generation}${tests}${trigger}`;
}

function debugLog(message: string): void {
  if (process.env.PI_FUNZZY_DEBUG === "1") {
    console.error(`[pi-funzzy] ${message}`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
