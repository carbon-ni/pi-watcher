import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";

import { LEGACY_CAPABILITY_PROFILE } from "../domain/capabilities.js";
import { CapabilityCache, loadCapabilities } from "./capabilities.js";

const negotiated = {
  protocolVersion: "1.1",
  schemaVersion: 2,
  instance: { token: "fz-7f3a", startedAtEpochMs: 1710000000000 },
  methods: ["status", "targets", "run", "capabilities", "subscribe", "cancel", "output"],
  optionalFields: ["batchId", "pending", "tasks"],
  limits: { outputRetentionBytes: 1048576, maxResponseBytes: 65536, maxEvidenceLines: 40 },
  features: {
    atomicAwait: true,
    subscription: true,
    correlatedSnapshots: true,
    outputRetrieval: true,
    pendingWork: true,
    sequentialOverride: true,
  },
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

test("negotiates capabilities once per watcher instance", async () => {
  let requests = 0;
  await withSocketServer(
    (_request, socket) => {
      requests += 1;
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: "capabilities", result: negotiated })}\n`);
    },
    async (socketPath) => {
      const cache = new CapabilityCache();
      const first = await loadCapabilities(socketPath, cache, 500);
      const second = await loadCapabilities(socketPath, cache, 500);
      assert.equal(first.instance.token, "fz-7f3a");
      assert.equal(second, first);
      assert.equal(requests, 1);
    },
  );
});

test("invalidates the cache on disconnect or restart identity change", async () => {
  let requests = 0;
  await withSocketServer(
    (_request, socket) => {
      requests += 1;
      const token = requests === 1 ? "fz-7f3a" : "fz-9b21";
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "capabilities",
          result: { ...negotiated, instance: { ...negotiated.instance, token } },
        })}\n`,
      );
    },
    async (socketPath) => {
      const cache = new CapabilityCache();
      const first = await loadCapabilities(socketPath, cache, 500);
      assert.equal(first.instance.token, "fz-7f3a");

      // Watcher restarted: the caller observes the disconnect and invalidates.
      cache.invalidate();
      const afterRestart = await loadCapabilities(socketPath, cache, 500);
      assert.equal(afterRestart.instance.token, "fz-9b21");
      assert.equal(requests, 2);
    },
  );
});

test("maps a missing capabilities method to the legacy profile without probing", async () => {
  let requests = 0;
  await withSocketServer(
    (_request, socket) => {
      requests += 1;
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "capabilities",
          error: { code: -32601, message: "Method not found" },
        })}\n`,
      );
    },
    async (socketPath) => {
      const cache = new CapabilityCache();
      const profile = await loadCapabilities(socketPath, cache, 500);
      assert.equal(profile.source, "legacy");
      assert.deepEqual(profile.methods, LEGACY_CAPABILITY_PROFILE.methods);
      assert.equal(profile.features.atomicAwait, false);
      // The method-not-found response is the whole negotiation: no per-feature probes.
      assert.equal(requests, 1);
    },
  );
});

test("fails closed on a malformed capabilities payload", async () => {
  await withSocketServer(
    (_request, socket) => {
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "capabilities",
          result: { ...negotiated, schemaVersion: "2" },
        })}\n`,
      );
    },
    async (socketPath) => {
      const cache = new CapabilityCache();
      await assert.rejects(
        () => loadCapabilities(socketPath, cache, 500),
        /"schemaVersion" must be a number/,
      );
    },
  );
});

test("rejects an oversized capabilities response", async () => {
  await withSocketServer(
    (_request, socket) => {
      const padded = {
        ...negotiated,
        methods: Array.from({ length: 9000 }, (_, index) => `method-${index}`),
      };
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: "capabilities", result: padded })}\n`);
    },
    async (socketPath) => {
      const cache = new CapabilityCache();
      await assert.rejects(() => loadCapabilities(socketPath, cache, 500), /exceeded 64KB/);
    },
  );
});
