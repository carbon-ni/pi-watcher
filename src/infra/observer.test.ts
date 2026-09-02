import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test, vi } from "vitest";

import { createPollingPort, createSubscriptionPort, waitForConnect } from "./observer.js";
import type { WatcherStatus } from "../domain/watcher.js";

const STATUS: WatcherStatus = {
  generation: 4,
  state: "passed",
  trigger: "src/main.rs",
  commands: ["cargo test"],
  durationMs: 42,
  failures: [],
};

const SNAPSHOT = {
  instance: { token: "fz-7f3a", startedAtEpochMs: 1710000000000 },
  generation: 4,
  batchId: "b-19",
  state: "passed",
  trigger: "src/main.rs",
  commands: ["make all"],
  tasks: [{ id: "t-1", name: "test @agent-final", state: "passed", durationMs: 42 }],
  services: [],
  pending: 0,
  freshness: "current",
  durationMs: 42,
  failures: [],
  paths: [],
  configuredConcurrency: 2,
  effectiveConcurrency: 2,
  concurrencySource: "config",
};

async function withSocketServer(
  handler: (request: Buffer | string, socket: Socket) => void,
  run: (socketPath: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.once("data", (request) => handler(request, socket));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await run(socketPath);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

class FakeSocket extends EventEmitter {
  destroyed = false;

  destroy(): void {
    this.destroyed = true;
  }
}

async function collect<T>(generator: AsyncGenerator<T>, count: number): Promise<T[]> {
  const values: T[] = [];
  for await (const value of generator) {
    values.push(value);
    if (values.length >= count) break;
  }
  return values;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("createPollingPort", () => {
  test("polls immediately and yields polled observations with a monotonic sequence", async () => {
    const queryStatus = vi.fn().mockResolvedValue(STATUS);
    const port = createPollingPort(queryStatus, "/tmp/funzzy.sock", 1_000);
    const controller = new AbortController();

    const first = await port.open(controller.signal).next();
    assert.equal(first.done, false);
    if (first.done) throw new Error("expected an observation");
    assert.equal(queryStatus.mock.calls.length, 1);
    assert.equal(first.value.source, "polled");
    assert.equal(first.value.freshness, "current");
    assert.equal(first.value.status, STATUS);
    assert.equal(first.value.snapshot, null);

    controller.abort();
    const afterAbort = await port.open(controller.signal).next();
    assert.equal(afterAbort.done, true);
  });

  test("never overlaps reads and increments sequence across reconnects", async () => {
    const queryStatus = vi.fn().mockResolvedValue(STATUS);
    const port = createPollingPort(queryStatus, "/tmp/funzzy.sock", 10);
    const controller = new AbortController();

    const stream = port.open(controller.signal);
    const first = await stream.next();
    assert.equal(first.done, false);
    if (first.done) throw new Error("expected an observation");
    assert.equal(first.value.sequence, 1);
    const second = await stream.next();
    assert.equal(second.done, false);
    if (second.done) throw new Error("expected an observation");
    assert.equal(second.value.sequence, 2);
    controller.abort();
  });

  test("throws transport errors so the observer can reconnect", async () => {
    const queryStatus = vi.fn().mockRejectedValue(new Error("socket gone"));
    const port = createPollingPort(queryStatus, "/tmp/funzzy.sock", 1_000);
    const controller = new AbortController();

    await assert.rejects(() => port.open(controller.signal).next(), /socket gone/);
    controller.abort();
  });
});

describe("createSubscriptionPort", () => {
  test("cleans handshake listeners before destroying on abort", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const addAbort = vi.spyOn(controller.signal, "addEventListener");
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const pending = waitForConnect(socket as unknown as Socket, controller.signal);

    assert.equal(socket.listenerCount("connect"), 1);
    assert.equal(socket.listenerCount("error"), 1);
    assert.equal(addAbort.mock.calls.length, 1);
    controller.abort();

    await assert.rejects(pending, /Funzzy subscription connection aborted/);
    assert.equal(socket.listenerCount("connect"), 0);
    assert.equal(socket.listenerCount("error"), 0);
    assert.equal(removeAbort.mock.calls.length, 1);
    assert.equal(socket.destroyed, true);
    socket.emit("connect");
  });

  test("preserves the original connection error and cleans listeners", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const addAbort = vi.spyOn(controller.signal, "addEventListener");
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const pending = waitForConnect(socket as unknown as Socket, controller.signal);
    const error = new Error("connect failed");

    assert.equal(socket.listenerCount("connect"), 1);
    assert.equal(socket.listenerCount("error"), 1);
    assert.equal(addAbort.mock.calls.length, 1);
    socket.emit("error", error);

    await assert.rejects(pending, (actual) => actual === error);
    assert.equal(socket.listenerCount("connect"), 0);
    assert.equal(socket.listenerCount("error"), 0);
    assert.equal(removeAbort.mock.calls.length, 1);
    assert.equal(socket.destroyed, false);
  });

  test("connect wins a race when it settles before abort", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const addAbort = vi.spyOn(controller.signal, "addEventListener");
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const pending = waitForConnect(socket as unknown as Socket, controller.signal);

    assert.equal(socket.listenerCount("connect"), 1);
    assert.equal(socket.listenerCount("error"), 1);
    assert.equal(addAbort.mock.calls.length, 1);
    socket.emit("connect");
    controller.abort();

    await pending;
    assert.equal(socket.listenerCount("connect"), 0);
    assert.equal(socket.listenerCount("error"), 0);
    assert.equal(removeAbort.mock.calls.length, 1);
    assert.equal(socket.destroyed, false);
  });

  test("already-aborted signals install no listeners and destroy the socket", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      waitForConnect(socket as unknown as Socket, controller.signal),
      /Funzzy subscription connection aborted/,
    );
    assert.equal(socket.listenerCount("connect"), 0);
    assert.equal(socket.listenerCount("error"), 0);
    assert.equal(socket.destroyed, true);
  });

  test("preserves connection errors when the socket cannot connect", async () => {
    const port = createSubscriptionPort(join(tmpdir(), `funzzy-missing-${process.pid}.sock`));

    await assert.rejects(
      () => port.open(new AbortController().signal).next(),
      /ENOENT|ECONNREFUSED/,
    );
  });

  test("rejects an already-aborted connection with a stable cancellation error", async () => {
    const controller = new AbortController();
    controller.abort();
    const port = createSubscriptionPort(join(tmpdir(), "funzzy-never-connect.sock"));

    await assert.rejects(
      () => port.open(controller.signal).next(),
      /Funzzy subscription connection aborted/,
    );
  });

  test("aborting before connect destroys the socket without writing subscribe", async () => {
    let requests = 0;
    await withSocketServer(
      () => {
        requests += 1;
      },
      async (socketPath) => {
        const controller = new AbortController();
        const port = createSubscriptionPort(socketPath);
        const next = port.open(controller.signal).next();
        controller.abort();

        await assert.rejects(next, /Funzzy subscription connection aborted/);
        assert.equal(requests, 0);
      },
    );
  });

  test("streams the immediate snapshot and snapshot notifications", async () => {
    await withSocketServer(
      (request, socket) => {
        assert.match(request.toString(), /"method":"subscribe"/);
        socket.end(
          `${JSON.stringify({ jsonrpc: "2.0", id: "subscribe", result: SNAPSHOT })}\n` +
            `${JSON.stringify({ jsonrpc: "2.0", method: "snapshot", params: { ...SNAPSHOT, generation: 5 } })}\n`,
        );
      },
      async (socketPath) => {
        const port = createSubscriptionPort(socketPath);
        const observations = await collect(port.open(new AbortController().signal), 2);
        const [first, second] = observations;
        assert.ok(first && second);
        assert.equal(first.sequence, 1);
        assert.equal(first.source, "subscription");
        assert.equal(first.freshness, "current");
        assert.equal(first.status.generation, 4);
        assert.equal(first.status.commands[0], "make all");
        assert.deepEqual(first.snapshot, SNAPSHOT);
        assert.equal(second.sequence, 2);
        assert.equal(second.status.generation, 5);
        assert.deepEqual(second.snapshot, { ...SNAPSHOT, generation: 5 });
      },
    );
  });

  test("propagates the subscribe RPC error", async () => {
    await withSocketServer(
      (_request, socket) => {
        socket.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: "subscribe",
            error: { code: -32601, message: "Method not found" },
          })}\n`,
        );
      },
      async (socketPath) => {
        const port = createSubscriptionPort(socketPath);
        await assert.rejects(
          () => port.open(new AbortController().signal).next(),
          /Funzzy RPC error -32601: Method not found/,
        );
      },
    );
  });

  test("fails closed on a malformed snapshot notification", async () => {
    await withSocketServer(
      (_request, socket) => {
        socket.end(
          `${JSON.stringify({ jsonrpc: "2.0", id: "subscribe", result: SNAPSHOT })}\n` +
            `${JSON.stringify({ jsonrpc: "2.0", method: "snapshot", params: { ...SNAPSHOT, generation: "5" } })}\n`,
        );
      },
      async (socketPath) => {
        const port = createSubscriptionPort(socketPath);
        const generator = port.open(new AbortController().signal);
        await generator.next();
        await assert.rejects(() => generator.next(), /"generation" must be a number/);
      },
    );
  });

  test("rejects an oversized notification line", async () => {
    await withSocketServer(
      (_request, socket) => {
        const padded = { ...SNAPSHOT, batchId: "x".repeat(70_000) };
        socket.end(
          `${JSON.stringify({ jsonrpc: "2.0", id: "subscribe", result: SNAPSHOT })}\n` +
            `${JSON.stringify({ jsonrpc: "2.0", method: "snapshot", params: padded })}\n`,
        );
      },
      async (socketPath) => {
        const port = createSubscriptionPort(socketPath);
        const generator = port.open(new AbortController().signal);
        await generator.next();
        await assert.rejects(() => generator.next(), /exceeded 64KB/);
      },
    );
  });

  test("ends the stream when the server closes the connection", async () => {
    await withSocketServer(
      (_request, socket) => {
        socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: "subscribe", result: SNAPSHOT })}\n`);
      },
      async (socketPath) => {
        const port = createSubscriptionPort(socketPath);
        const generator = port.open(new AbortController().signal);
        const first = await generator.next();
        assert.equal(first.done, false);
        if (first.done) throw new Error("expected an observation");
        assert.equal(first.value.status.generation, 4);
        const done = await generator.next();
        assert.equal(done.done, true);
      },
    );
  });
});
