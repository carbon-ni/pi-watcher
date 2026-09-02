import { createConnection } from "node:net";
import type { Socket } from "node:net";

import type { ObserverPort } from "../application/observer.js";
import {
  decodeWatcherCorrelatedSnapshot,
  snapshotToStatus,
  type WatcherCorrelatedSnapshot,
} from "../domain/capabilities.js";
import type { WatcherObservation } from "../domain/observation.js";
import type { WatcherStatus } from "../domain/watcher.js";

/**
 * Observer ports (contract §7): transport adapters that expose one
 * `WatcherObservation` stream. Size bound follows the client contract; the
 * observer owns reconnect policy. No sockets leak into application/domain.
 */

const MAX_RESPONSE_BYTES = 65_536;

export type QueryStatusFn = (socketPath: string, timeoutMs?: number) => Promise<WatcherStatus>;

/**
 * Legacy polling port: one non-overlapping `queryStatus` read per interval.
 * Yields `source: "polled"` observations so consumers can mark the weaker
 * freshness guarantee. Capability-gated by the lifecycle (contract §8).
 */
export function createPollingPort(
  queryStatus: QueryStatusFn,
  socketPath: string,
  pollIntervalMs: number,
): ObserverPort {
  let sequence = 0;
  return {
    async *open(signal: AbortSignal): AsyncGenerator<WatcherObservation> {
      while (!signal.aborted) {
        const status = await queryStatus(socketPath);
        if (signal.aborted) return;
        sequence += 1;
        yield { sequence, status, source: "polled", freshness: "current", snapshot: null };
        await abortableDelay(pollIntervalMs, signal);
      }
    },
  };
}

/**
 * Subscription port for the agreed additive contract (fixtures in
 * `src/domain/fixtures/`): `subscribe` returns the immediate correlated
 * snapshot, then `snapshot` notifications stream transitions. The stream ends
 * when the server closes the connection; the observer reconnects.
 */
export function createSubscriptionPort(socketPath: string): ObserverPort {
  return {
    open: (signal) => subscribeToSnapshots(socketPath, signal),
  };
}

async function* subscribeToSnapshots(
  socketPath: string,
  signal: AbortSignal,
): AsyncGenerator<WatcherObservation> {
  let sequence = 0;
  const socket = createConnection(socketPath);
  try {
    await waitForConnect(socket, signal);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: "subscribe", method: "subscribe" })}\n`);

    for await (const line of socketJsonLines(socket, signal)) {
      const message = parseJsonRpcMessage(line);
      if (message.error !== undefined) {
        throw new Error(
          `Funzzy RPC error ${message.error.code}: ${message.error.message}${
            message.error.data === undefined ? "" : ` (${JSON.stringify(message.error.data)})`
          }`,
        );
      }
      if (message.id === "subscribe" && message.result !== undefined) {
        sequence += 1;
        const snapshot = decodeWatcherCorrelatedSnapshot(message.result);
        yield observationFromSnapshot(snapshot, sequence);
        continue;
      }
      if (message.method === "snapshot" && message.params !== undefined) {
        sequence += 1;
        const snapshot = decodeWatcherCorrelatedSnapshot(message.params);
        yield observationFromSnapshot(snapshot, sequence);
        continue;
      }
      throw new Error(`Funzzy subscription sent an unexpected message: ${line.slice(0, 200)}`);
    }
  } finally {
    socket.destroy();
  }
}

function observationFromSnapshot(
  snapshot: WatcherCorrelatedSnapshot,
  sequence: number,
): WatcherObservation {
  return {
    sequence,
    status: snapshotToStatus(snapshot),
    source: "subscription",
    freshness: snapshot.freshness,
    snapshot,
  };
}

const SUBSCRIPTION_ABORT_MESSAGE = "Funzzy subscription connection aborted";

export function waitForConnect(socket: Socket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => settle(error);
    const onConnect = (): void => settle();
    const onAbort = (): void => {
      settle(new Error(SUBSCRIPTION_ABORT_MESSAGE));
      socket.destroy();
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code: unknown; message: unknown; data?: unknown };
}

function parseJsonRpcMessage(line: string): JsonRpcMessage {
  try {
    return JSON.parse(line) as JsonRpcMessage;
  } catch {
    throw new Error(`Funzzy subscription sent invalid JSON: ${line.slice(0, 200)}`);
  }
}

async function* socketJsonLines(socket: Socket, signal: AbortSignal): AsyncGenerator<string> {
  let buffer = "";
  const queue: string[] = [];
  let closed = false;
  let streamError: Error | null = null;
  const waiters: Array<(line: string | undefined) => void> = [];

  const push = (line: string): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queue.push(line);
  };

  const settle = (state: "closed" | Error): void => {
    if (closed || streamError !== null) return;
    if (state === "closed") closed = true;
    else streamError = state;
    for (const waiter of waiters.splice(0)) waiter(undefined);
  };

  const onAbort = (): void => {
    socket.destroy();
    settle("closed");
  };
  signal.addEventListener("abort", onAbort, { once: true });

  // Reads through a call so TS does not keep the closure-captured variable
  // narrowed to its initial value inside the loop below.
  const currentError = (): Error | null => streamError;

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > MAX_RESPONSE_BYTES) {
      settle(new Error("Funzzy response exceeded 64KB"));
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      push(line);
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("end", () => settle("closed"));
  socket.on("close", () => settle("closed"));
  socket.on("error", (error) => settle(error));

  try {
    while (true) {
      if (signal.aborted) return;
      const line = queue.shift();
      if (line !== undefined) {
        yield line;
        continue;
      }
      if (closed) return;
      const transportError = currentError();
      if (transportError !== null) {
        throw new Error(transportError.message, { cause: transportError });
      }
      const value = await new Promise<string | undefined>((resolve) => waiters.push(resolve));
      if (value !== undefined) {
        yield value;
        continue;
      }
      // Unblocked by close/error/abort; loop re-checks settled state.
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    socket.destroy();
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
