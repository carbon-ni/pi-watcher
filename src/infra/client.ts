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
import { decodeAtomicRunResult, type AtomicRunResult } from "../domain/verification.js";
import {
  decodeWatcherOutput,
  WatcherOutputNotFoundError,
  WatcherOutputTaskNotFoundError,
  type WatcherOutputRequest,
  type WatcherOutputResult,
} from "../domain/output.js";
import { decodeWatcherCancel } from "../domain/cancel.js";
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
  method?: unknown;
  params?: unknown;
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

/** Request or socket wait exceeded its deadline without a response. */
export class FunzzyRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunzzyRequestTimeoutError";
  }
}

/** Socket closed, connection refused, or retries exhausted. */
export class FunzzyDisconnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunzzyDisconnectError";
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

/**
 * Atomic run-and-await (agreed additive contract): one connection carries an
 * immediate schedule acknowledgement `{runId}` and then a `runComplete`
 * notification `{runId, snapshot}` at terminal. `onSchedule` fires as soon as
 * the exact generation is known, so cancellation effects can be armed before
 * the run finishes. AbortSignal interrupts the wait without touching the
 * server; the caller is responsible for the exact-generation cancel. Never
 * retried after connection because scheduling is not idempotent.
 */
export async function requestRunAtomic(
  socketPath: string,
  target: string,
  timeoutMs = 120_000,
  onSchedule?: (runId: number) => void,
  signal?: AbortSignal,
): Promise<AtomicRunResult> {
  const deadline = Date.now() + timeoutMs;
  let lastConnectionError: Error | undefined;
  let retries = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Funzzy atomic run was cancelled");
    try {
      const result = await runAtomicOnce(
        socketPath,
        target,
        Math.max(1, deadline - Date.now()),
        onSchedule,
        signal,
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
  throw new FunzzyDisconnectError(`Funzzy unavailable after ${timeoutMs}ms${reason}`);
}

function runAtomicOnce(
  socketPath: string,
  target: string,
  timeoutMs: number,
  onSchedule: ((runId: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<AtomicRunResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    let connected = false;
    let scheduled = false;

    const onAbort = (): void => fail(new Error("Funzzy atomic run was cancelled"));
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };

    const parseMessage = (line: string): void => {
      try {
        const parsed = JSON.parse(line) as ControlResponse;
        if (parsed.jsonrpc !== "2.0") {
          throw new Error(`Unsupported Funzzy JSON-RPC version: ${parsed.jsonrpc}`);
        }
        if (parsed.error)
          throw new FunzzyRpcError(
            parsed.error.code,
            formatRpcError(parsed.error),
            parsed.error.data,
          );
        if (!scheduled) {
          if (parsed.result === undefined) throw new Error("Funzzy run response has no result");
          scheduled = true;
          const runId = decodeWatcherRun(parsed.result);
          onSchedule?.(runId);
          return;
        }
        if (parsed.method === "runComplete" && parsed.params !== undefined) {
          const result = decodeAtomicRunResult(parsed.params);
          settled = true;
          cleanup();
          socket.end();
          resolve(result);
          return;
        }
        throw new Error(`Funzzy atomic run sent an unexpected message: ${line.slice(0, 200)}`);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(timeoutMs, () =>
      fail(new FunzzyRequestTimeoutError(`Funzzy atomic run timed out after ${timeoutMs}ms`)),
    );
    socket.once("error", (error) => {
      if (!connected && isRetryableSocketError(error)) {
        fail(new RetryableRequestError(error));
        return;
      }
      fail(error);
    });
    socket.once("connect", () => {
      connected = true;
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "run", method: "run", params: { target, wait: true } })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 65_536) {
        fail(new Error("Funzzy response exceeded 64KB"));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0 && !settled) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        parseMessage(line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("end", () => {
      if (settled) return;
      fail(new FunzzyDisconnectError("Funzzy closed the socket without a complete response"));
    });
  });
}

/**
 * Compare-and-cancel an exact generation (agreed additive contract,
 * `src/domain/fixtures/cancel.json`). The instance token plus generation make
 * a stale request a safe no-op; read-only semantics allow interrupted
 * transport retries. Escalation arrives as RPC error -32021 and is mapped by
 * the cancel port.
 */
export function requestCancel(
  socketPath: string,
  generation: number,
  instanceToken: string,
  timeoutMs = 3_000,
): Promise<{ cancelled: boolean; generation: number }> {
  return sendRequest(
    socketPath,
    {
      jsonrpc: "2.0",
      id: "cancel",
      method: "cancel",
      params: { generation, instanceToken },
    },
    timeoutMs,
    true,
    decodeWatcherCancel,
  );
}

/**
 * Retrieve bounded retained output for an exact generation (agreed additive
 * contract, `src/domain/fixtures/output.json`). Read-only: interrupted
 * transport may be retried. RPC errors map to actionable domain errors, and
 * an AbortSignal cancels the request without leaving a socket behind.
 */
export async function requestOutput(
  socketPath: string,
  request: WatcherOutputRequest,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<WatcherOutputResult> {
  try {
    return await sendRequest(
      socketPath,
      {
        jsonrpc: "2.0",
        id: "output",
        method: "output",
        params: {
          generation: request.generation,
          ...(request.task === null || request.task === undefined ? {} : { task: request.task }),
          ...(request.stream === null || request.stream === undefined
            ? {}
            : { stream: request.stream }),
          ...(request.full === undefined ? {} : { full: request.full }),
          ...(request.tail === undefined ? {} : { tail: request.tail }),
        },
      },
      timeoutMs,
      true,
      (value) => decodeWatcherOutput(value),
      signal,
      "Funzzy output retrieval was cancelled",
    );
  } catch (error) {
    if (error instanceof FunzzyRpcError) {
      if (error.code === -32010) throw new WatcherOutputNotFoundError(request.generation);
      if (error.code === -32011 && request.task) {
        throw new WatcherOutputTaskNotFoundError(request.generation, request.task);
      }
    }
    throw error;
  }
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
  signal?: AbortSignal,
  cancelMessage = "Funzzy request was cancelled",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastConnectionError: Error | undefined;
  let retries = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(cancelMessage);
    try {
      const result = await sendRequestOnce<T>(
        socketPath,
        request,
        Math.max(1, deadline - Date.now()),
        retryInterrupted,
        decode,
        signal,
        cancelMessage,
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
  throw new FunzzyDisconnectError(`Funzzy unavailable after ${timeoutMs}ms${reason}`);
}

function sendRequestOnce<T>(
  socketPath: string,
  request: object,
  timeoutMs: number,
  retryInterrupted: boolean,
  decode: (value: unknown) => T,
  signal?: AbortSignal,
  cancelMessage = "Funzzy request was cancelled",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;
    let connected = false;

    const onAbort = (): void => {
      fail(new Error(cancelMessage));
    };

    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    socket.setTimeout(timeoutMs, () =>
      fail(new FunzzyRequestTimeoutError(`Funzzy request timed out after ${timeoutMs}ms`)),
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
        if (parsed.error)
          throw new FunzzyRpcError(
            parsed.error.code,
            formatRpcError(parsed.error),
            parsed.error.data,
          );
        if (parsed.result === undefined) throw new Error("Funzzy response has no result");
        const decoded = decode(parsed.result);
        settled = true;
        cleanup();
        socket.end();
        resolve(decoded);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("end", () => {
      if (settled) return;
      const error = new FunzzyDisconnectError(
        "Funzzy closed the socket without a complete response",
      );
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
