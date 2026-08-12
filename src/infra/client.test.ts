import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { formatStatus, listTargets, queryStatus, requestRun } from "./client.js";

const passed = {
  generation: 4,
  state: "passed" as const,
  trigger: "src/main.rs",
  commands: ["cargo test"],
  durationMs: 42,
  failures: [],
};

test("retries while the Funzzy socket is starting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: "status", result: passed })}\n`);
    });
  });
  const delayedStart = setTimeout(() => server.listen(socketPath), 75);

  try {
    assert.deepEqual(await queryStatus(socketPath, 500), passed);
  } finally {
    clearTimeout(delayedStart);
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries status when Funzzy closes a connection during restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  let connections = 0;
  const server = createServer((socket) => {
    socket.once("data", () => {
      connections += 1;
      if (connections === 1) {
        socket.end();
        return;
      }
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: "status", result: passed })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    assert.deepEqual(await queryStatus(socketPath, 500), passed);
    assert.equal(connections, 2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("queries Funzzy status over its Unix socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", (request) => {
      assert.match(request.toString(), /\"jsonrpc\":\"2\.0\"/);
      assert.match(request.toString(), /\"method\":\"status\"/);
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: "status", result: passed })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    assert.deepEqual(await queryStatus(socketPath, 500), passed);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("lists available Funzzy targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const targets = [{ name: "final checks @agent-final", commands: ["cargo test"] }];
  const server = createServer((socket) => {
    socket.once("data", (request) => {
      assert.match(request.toString(), /\"jsonrpc\":\"2\.0\"/);
      assert.match(request.toString(), /\"method\":\"targets\"/);
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: "targets", result: targets })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    assert.deepEqual(await listTargets(socketPath, 500), targets);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("requests a named Funzzy target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", (request) => {
      assert.match(request.toString(), /\"jsonrpc\":\"2\.0\"/);
      assert.match(request.toString(), /\"method\":\"run\"/);
      assert.match(request.toString(), /@agent-final/);
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: "run", result: { runId: 7 } })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    assert.equal(await requestRun(socketPath, "@agent-final", 500), 7);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports JSON-RPC errors with code and message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "run",
          error: { code: -32602, message: "Invalid params", data: "target is required" },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => requestRun(socketPath, "", 500),
      /Funzzy RPC error -32602: Invalid params \(target is required\)/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when Funzzy is unavailable", async () => {
  await assert.rejects(() => queryStatus("/tmp/funzzy-does-not-exist.sock", 50));
});

test("formats compact passed and failed receipts", () => {
  assert.equal(
    formatStatus(passed),
    "PASS gen=4 tests=cargo test duration=42ms trigger=src/main.rs",
  );
  assert.equal(
    formatStatus({ ...passed, state: "failed", failures: ["cargo test exited with status 1"] }),
    "FAIL gen=4 failures=1 tests=cargo test trigger=src/main.rs\n- cargo test exited with status 1",
  );
});
