import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import {
  formatStatus,
  listTargets,
  queryStatus,
  requestCancel,
  requestOutput,
  requestRun,
  requestRunAtomic,
} from "./client.js";
import { FunzzyDisconnectError, FunzzyRpcError } from "./client.js";

const passed = {
  generation: 4,
  state: "passed" as const,
  trigger: "src/main.rs",
  commands: ["cargo test"],
  durationMs: 42,
  failures: [],
};

const passedOutputSnapshot = {
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

test("fails closed on a malformed status payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      // Wrong-type generation, exactly as a broken protocol change would emit.
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "status",
          result: { ...passed, generation: "4" },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => queryStatus(socketPath, 500),
      /"generation" must be a number, got "4"/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed on a malformed targets payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      // A target without its required name.
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "targets",
          result: [{ commands: ["cargo test"] }],
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => listTargets(socketPath, 500),
      /target at index 0: "name" is required/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed on a malformed run payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      // Wrong-type run id.
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "run",
          result: { runId: "7" },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => requestRun(socketPath, "@agent-final", 500),
      /"runId" must be a number, got "7"/,
    );
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

const outputResult = {
  generation: 7,
  task: "lint",
  stream: "stdout",
  observedBytes: 8192,
  retainedBytes: 4096,
  evicted: false,
  truncated: false,
  lines: ["line one", "line two"],
};

test("requests bounded output for an exact generation and task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", (request) => {
      assert.match(request.toString(), /"method":"output"/);
      assert.match(request.toString(), /"generation":7/);
      assert.match(request.toString(), /"task":"lint"/);
      assert.match(request.toString(), /"stream":"stdout"/);
      assert.match(request.toString(), /"tail":2/);
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: "output", result: outputResult })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    const result = await requestOutput(
      socketPath,
      { generation: 7, task: "lint", stream: "stdout", tail: 2 },
      500,
    );
    assert.equal(result.generation, 7);
    assert.equal(result.task, "lint");
    assert.deepEqual(result.lines, ["line one", "line two"]);
    assert.equal(result.truncated, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps an unknown generation to an actionable domain error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: "output", error: { code: -32010, message: "generation output not found" } })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => requestOutput(socketPath, { generation: 99 }, 500),
      /Funzzy output for generation 99 is not available/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps an unknown task to an actionable domain error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: "output", error: { code: -32011, message: "task output not found" } })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => requestOutput(socketPath, { generation: 7, task: "nope" }, 500),
      /Funzzy output for task "nope" in generation 7 is not available/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed with a disconnect error when the server drops the socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => requestOutput(socketPath, { generation: 7 }, 400),
      (error: unknown) => error instanceof FunzzyDisconnectError,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborts the retrieval promptly on AbortSignal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const controller = new AbortController();
  const request = requestOutput(socketPath, { generation: 7 }, 5_000, controller.signal);
  controller.abort();

  try {
    await assert.rejects(request, /Funzzy output retrieval was cancelled/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels an exact generation with compare-and-cancel identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", (request) => {
      assert.match(request.toString(), /"method":"cancel"/);
      assert.match(request.toString(), /"generation":7/);
      assert.match(request.toString(), /"instanceToken":"fz-7f3a"/);
      socket.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: "cancel", result: { cancelled: true, generation: 7 } })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    const result = await requestCancel(socketPath, 7, "fz-7f3a", 500);
    assert.deepEqual(result, { cancelled: true, generation: 7 });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("propagates an escalated-cleanup RPC error for the cancel request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: "cancel", error: { code: -32021, message: "Cancellation escalated" } })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => requestCancel(socketPath, 7, "fz-7f3a", 500),
      (error: unknown) => error instanceof FunzzyRpcError && error.code === -32021,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads the atomic schedule ack and the runComplete snapshot from one connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", (request) => {
      assert.match(request.toString(), /"wait":true/);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: "run", result: { runId: 7 } })}\n`);
      setTimeout(() => {
        socket.end(
          `${JSON.stringify({ jsonrpc: "2.0", method: "runComplete", params: { runId: 7, snapshot: passedOutputSnapshot } })}\n`,
        );
      }, 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const scheduled: number[] = [];
  try {
    const result = await requestRunAtomic(socketPath, "lint", 500, (runId) => {
      scheduled.push(runId);
    });
    assert.deepEqual(scheduled, [7]);
    assert.equal(result.runId, 7);
    assert.equal(result.snapshot.state, "passed");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails the atomic run on a schedule-ack RPC error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: "run", error: { code: -32001, message: "Run superseded", data: { supersedingRunId: 8 } } })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => requestRunAtomic(socketPath, "lint", 500),
      (error: unknown) => error instanceof FunzzyRpcError && error.code === -32001,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails the atomic run on a runComplete RPC error after scheduling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: "run", result: { runId: 7 } })}\n`);
      setTimeout(() => {
        socket.end(
          `${JSON.stringify({ jsonrpc: "2.0", method: "runComplete", error: { code: -32002, message: "Run cancelled" } })}\n`,
        );
      }, 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => requestRunAtomic(socketPath, "lint", 500),
      (error: unknown) => error instanceof FunzzyRpcError && error.code === -32002,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports disconnect when the atomic run connection drops after scheduling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-extension-"));
  const socketPath = join(directory, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: "run", result: { runId: 7 } })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => requestRunAtomic(socketPath, "lint", 500),
      (error: unknown) => error instanceof FunzzyDisconnectError,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
