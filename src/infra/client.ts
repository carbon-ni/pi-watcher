import { createConnection } from "node:net";

// Wire contract: the Funzzy control server (Rust `src/control.rs`) emits
// JSON-RPC 2.0 with `status` -> ControlState (serde camelCase), `targets` ->
// ControlTarget list, and `run` -> { "runId": generation }. Every result is
// decoded from `unknown` (see ../domain/watcher.ts) so protocol drift fails
// closed with an actionable error instead of a generic cast. Change the Rust
// serializer and this decoder together.
import {
  decodeWatcherCapabilities,
  type WatcherCapabilityProfile,
} from "../domain/capabilities.js";
import {
  decodeWatcherRun,
  decodeWatcherStatus,
  decodeWatcherTargets,
  type WatcherStatus,
  type WatcherTarget,
} from "../domain/watcher.js";

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

interface ControlResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: RpcError;
}

/**
 * JSON-RPC error returned by the Funzzy server, carrying its numeric code so
 * clients can react to specific protocol signals (e.g. -32601 Method not
 * found during capability negotiation) without parsing messages.
 */
export class FunzzyRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "FunzzyRpcError";
  }
}

export function queryCapabilities(
  socketPath: string,
  timeoutMs = 1_000,
): Promise<WatcherCapabilityProfile> {
  return sendRequest(
    socketPath,
    { jsonrpc: "2.0", id: "capabilities", method: "capabilities" },
    timeoutMs,
    true,
    decodeWatcherCapabilities,
  );
}

export function queryStatus(socketPath: string, timeoutMs = 1_000): Promise<FunzzyStatus> {
  return sendRequest(
    socketPath,
    { jsonrpc: "2.0", id: "status", method: "status" },
    timeoutMs,
    true,
    decodeWatcherStatus,
  );
}

export function listTargets(socketPath: string, timeoutMs = 1_000): Promise<FunzzyTarget[]> {
  return sendRequest(
    socketPath,
    { jsonrpc: "2.0", id: "targets", method: "targets" },
    timeoutMs,
    false,
    decodeWatcherTargets,
  );
}

export async function requestRun(
  socketPath: string,
  target: string,
  timeoutMs = 1_000,
): Promise<number> {
  return sendRequest(
    socketPath,
    { jsonrpc: "2.0", id: "run", method: "run", params: { target } },
    timeoutMs,
    false,
    decodeWatcherRun,
  );
}

async function sendRequest<T>(
  socketPath: string,
  request: object,
  timeoutMs: number,
  retryInterrupted: boolean,
  decode: (value: unknown) => T,
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
        decode,
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
  decode: (value: unknown) => T,
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
        const parsed = JSON.parse(response.slice(0, newline)) as ControlResponse;
        if (parsed.jsonrpc !== "2.0") {
          throw new Error(`Unsupported Funzzy JSON-RPC version: ${parsed.jsonrpc}`);
        }
        if (parsed.error) throw new FunzzyRpcError(parsed.error.code, formatRpcError(parsed.error));
        if (parsed.result === undefined) throw new Error("Funzzy response has no result");
        const decoded = decode(parsed.result);
        settled = true;
        socket.end();
        resolve(decoded);
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
