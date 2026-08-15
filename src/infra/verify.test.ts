import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "vitest";

import { createAtomicVerifyPort, createLegacyVerifyPort } from "./verify.js";
import { SupersededRunError } from "../application/stable-run.js";
import type { WatcherStatus } from "../domain/watcher.js";

const SNAPSHOT = {
  instance: { token: "fz-7f3a", startedAtEpochMs: 1710000000000 },
  generation: 7,
  batchId: "b-21",
  state: "passed",
  trigger: "control:lint",
  commands: ["make all"],
  tasks: [{ id: "t-2", name: "lint", state: "passed", durationMs: 42 }],
  pending: 0,
  freshness: "current",
  durationMs: 42,
  failures: [],
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

describe("createAtomicVerifyPort", () => {
  const scheduleAck = `${JSON.stringify({ jsonrpc: "2.0", id: "run", result: { runId: 7 } })}\n`;

  test("returns a terminal outcome for the atomic run response", async () => {
    await withSocketServer(
      (request, socket) => {
        assert.match(request.toString(), /"wait":true/);
        assert.doesNotMatch(request.toString(), /"sequential"/);
        assert.match(request.toString(), /lint/);
        socket.write(scheduleAck);
        socket.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "runComplete",
            params: { runId: 7, snapshot: SNAPSHOT },
          })}\n`,
        );
      },
      async (socketPath) => {
        const port = createAtomicVerifyPort(socketPath, "fz-7f3a");
        const outcome = await port.runAndAwait({ target: "lint", timeoutMs: 500 });
        assert.equal(outcome.kind, "terminal");
        if (outcome.kind !== "terminal") return;
        assert.equal(outcome.generation, 7);
        assert.equal(outcome.source, "subscription");
        assert.equal(outcome.status.state, "passed");
        assert.equal(outcome.snapshot?.instance.token, "fz-7f3a");
      },
    );
  });

  test("sends the explicit sequential override", async () => {
    await withSocketServer(
      (request, socket) => {
        assert.match(request.toString(), /"sequential":true/);
        socket.write(scheduleAck);
        socket.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "runComplete",
            params: { runId: 7, snapshot: SNAPSHOT },
          })}\n`,
        );
      },
      async (socketPath) => {
        const port = createAtomicVerifyPort(socketPath, "fz-7f3a");
        const outcome = await port.runAndAwait({
          target: "lint",
          timeoutMs: 500,
          sequential: true,
        });
        assert.equal(outcome.kind, "terminal");
      },
    );
  });

  test("reports the scheduled generation through onSchedule before the terminal", async () => {
    await withSocketServer(
      (_request, socket) => {
        socket.write(scheduleAck);
        socket.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "runComplete",
            params: { runId: 7, snapshot: SNAPSHOT },
          })}\n`,
        );
      },
      async (socketPath) => {
        const scheduled: number[] = [];
        const port = createAtomicVerifyPort(socketPath, "fz-7f3a");
        const outcome = await port.runAndAwait({
          target: "lint",
          timeoutMs: 500,
          onSchedule: (runId) => scheduled.push(runId),
        });
        assert.deepEqual(scheduled, [7]);
        assert.equal(outcome.kind, "terminal");
      },
    );
  });

  test("returns aborted promptly when the signal fires during the atomic wait", async () => {
    await withSocketServer(
      (_request, socket) => {
        socket.write(scheduleAck);
        // Run never completes; the abort must interrupt the wait.
      },
      async (socketPath) => {
        const controller = new AbortController();
        const port = createAtomicVerifyPort(socketPath, "fz-7f3a");
        const outcomePromise = port.runAndAwait({
          target: "lint",
          timeoutMs: 5_000,
          signal: controller.signal,
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        controller.abort();
        const outcome = await outcomePromise;
        assert.equal(outcome.kind, "aborted");
      },
    );
  });

  test("reports restart when the snapshot instance differs from the negotiated one", async () => {
    await withSocketServer(
      (_request, socket) => {
        socket.write(scheduleAck);
        socket.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "runComplete",
            params: {
              runId: 7,
              snapshot: { ...SNAPSHOT, instance: { ...SNAPSHOT.instance, token: "fz-9b21" } },
            },
          })}\n`,
        );
      },
      async (socketPath) => {
        const port = createAtomicVerifyPort(socketPath, "fz-7f3a");
        const outcome = await port.runAndAwait({ target: "lint", timeoutMs: 500 });
        assert.equal(outcome.kind, "restart");
      },
    );
  });

  test("maps a supersede RPC error to the explicit reason", async () => {
    await withSocketServer(
      (_request, socket) => {
        socket.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: "run",
            error: {
              code: -32001,
              message: "Run superseded",
              data: { reason: "superseded", supersedingRunId: 8 },
            },
          })}\n`,
        );
      },
      async (socketPath) => {
        const port = createAtomicVerifyPort(socketPath, "fz-7f3a");
        const outcome = await port.runAndAwait({ target: "lint", timeoutMs: 500 });
        assert.deepEqual(outcome, { kind: "superseded", generation: null, supersedingRunId: 8 });
      },
    );
  });

  test("maps a cancel RPC error to the cancelled reason", async () => {
    await withSocketServer(
      (_request, socket) => {
        socket.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: "run",
            error: { code: -32002, message: "Run cancelled", data: { reason: "cancelled" } },
          })}\n`,
        );
      },
      async (socketPath) => {
        const port = createAtomicVerifyPort(socketPath, "fz-7f3a");
        const outcome = await port.runAndAwait({ target: "lint", timeoutMs: 500 });
        assert.equal(outcome.kind, "cancelled");
      },
    );
  });

  test("reports disconnect when the server closes without a response", async () => {
    await withSocketServer(
      (_request, socket) => {
        socket.end();
      },
      async (socketPath) => {
        const port = createAtomicVerifyPort(socketPath, "fz-7f3a");
        const outcome = await port.runAndAwait({ target: "lint", timeoutMs: 500 });
        assert.equal(outcome.kind, "disconnect");
      },
    );
  });

  test("reports timeout when no response arrives in time", async () => {
    await withSocketServer(
      () => {
        // Server stays silent; the client deadline decides.
      },
      async (socketPath) => {
        const port = createAtomicVerifyPort(socketPath, "fz-7f3a");
        const outcome = await port.runAndAwait({ target: "lint", timeoutMs: 50 });
        assert.equal(outcome.kind, "timeout");
      },
    );
  });

  test("reports unknown on a malformed result", async () => {
    await withSocketServer(
      (_request, socket) => {
        socket.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: "run",
            result: { runId: "7" },
          })}\n`,
        );
      },
      async (socketPath) => {
        const port = createAtomicVerifyPort(socketPath, "fz-7f3a");
        const outcome = await port.runAndAwait({ target: "lint", timeoutMs: 500 });
        assert.equal(outcome.kind, "unknown");
        if (outcome.kind === "unknown") assert.match(outcome.message, /runId/);
      },
    );
  });
});

describe("createLegacyVerifyPort", () => {
  const STATUS: WatcherStatus = {
    generation: 7,
    state: "passed",
    trigger: "control:lint",
    commands: ["make all"],
    durationMs: 42,
    failures: [],
  };

  function portWith(options: {
    requestRun?: () => Promise<number>;
    queryStatus?: () => Promise<WatcherStatus>;
  }) {
    const requestRun = (options.requestRun ?? (() => Promise.resolve(7))) as (
      socketPath: string,
      target: string,
    ) => Promise<number>;
    const queryStatus = (options.queryStatus ?? (() => Promise.resolve(STATUS))) as (
      socketPath: string,
    ) => Promise<WatcherStatus>;
    return createLegacyVerifyPort({
      socketPath: "/tmp/funzzy.sock",
      pollIntervalMs: 10,
      requestRun,
      queryStatus,
    });
  }

  test("returns a polled terminal outcome for a passed run", async () => {
    const port = portWith({});
    const outcome = await port.runAndAwait({ target: "lint", timeoutMs: 500 });
    assert.equal(outcome.kind, "terminal");
    if (outcome.kind !== "terminal") return;
    assert.equal(outcome.generation, 7);
    assert.equal(outcome.source, "polled");
    assert.equal(outcome.snapshot, null);
  });

  test("reports the scheduled generation through onSchedule on the polled path", async () => {
    const scheduled: number[] = [];
    const port = portWith({});
    const outcome = await port.runAndAwait({
      target: "lint",
      timeoutMs: 500,
      onSchedule: (runId) => scheduled.push(runId),
    });
    assert.deepEqual(scheduled, [7]);
    assert.equal(outcome.kind, "terminal");
  });

  test("maps a superseded run to the explicit reason", async () => {
    const port = portWith({
      queryStatus: () => Promise.reject(new SupersededRunError(6, 7)),
    });
    const outcome = await port.runAndAwait({ target: "lint", timeoutMs: 500 });
    assert.deepEqual(outcome, { kind: "superseded", generation: 6, supersedingRunId: 7 });
  });

  test("maps a wait timeout to the timeout reason", async () => {
    const port = portWith({
      queryStatus: () => Promise.reject(new Error("Funzzy run 7 timed out after 500ms")),
    });
    const outcome = await port.runAndAwait({ target: "lint", timeoutMs: 500 });
    assert.equal(outcome.kind, "timeout");
  });

  test("maps an aborted signal to the aborted reason", async () => {
    const controller = new AbortController();
    controller.abort();
    const port = portWith({});
    const outcome = await port.runAndAwait({
      target: "lint",
      timeoutMs: 500,
      signal: controller.signal,
    });
    assert.equal(outcome.kind, "aborted");
  });
});
