import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { connectSession, disconnectSession, isSessionDisconnected } from "./membership.js";

test("a disconnected session is reported disconnected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-member-"));
  const socketPath = join(directory, "control.sock");

  try {
    assert.equal(await isSessionDisconnected(socketPath, "session-a"), false);

    await disconnectSession(socketPath, "session-a");

    assert.equal(await isSessionDisconnected(socketPath, "session-a"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconnecting removes only the target session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-member-"));
  const socketPath = join(directory, "control.sock");

  try {
    await disconnectSession(socketPath, "session-a");
    await disconnectSession(socketPath, "session-b");
    await connectSession(socketPath, "session-a");

    assert.equal(await isSessionDisconnected(socketPath, "session-a"), false);
    assert.equal(await isSessionDisconnected(socketPath, "session-b"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disconnecting the same session twice is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-member-"));
  const socketPath = join(directory, "control.sock");

  try {
    await disconnectSession(socketPath, "session-a");
    await disconnectSession(socketPath, "session-a");
    await disconnectSession(socketPath, "session-b");

    assert.equal(await isSessionDisconnected(socketPath, "session-a"), true);
    assert.equal(await isSessionDisconnected(socketPath, "session-b"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconnecting an unknown session leaves state unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-member-"));
  const socketPath = join(directory, "control.sock");

  try {
    await disconnectSession(socketPath, "session-b");
    await connectSession(socketPath, "session-a");

    assert.equal(await isSessionDisconnected(socketPath, "session-a"), false);
    assert.equal(await isSessionDisconnected(socketPath, "session-b"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconnecting the last session removes the state file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-member-"));
  const socketPath = join(directory, "control.sock");

  try {
    await disconnectSession(socketPath, "session-a");
    await connectSession(socketPath, "session-a");

    assert.equal(await isSessionDisconnected(socketPath, "session-a"), false);
    const { access } = await import("node:fs/promises");
    await assert.rejects(() => access(join(directory, ".pi-funzzy-disconnected.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an empty session id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-member-"));
  const socketPath = join(directory, "control.sock");

  try {
    await assert.rejects(() => disconnectSession(socketPath, "  "), /must not be empty/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
