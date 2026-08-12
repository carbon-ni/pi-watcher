import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import {
  clearPinnedResponder,
  readResponder,
  recordAutomaticResponder,
  setPinnedResponder,
} from "./ownership.js";

test("uses latest automatic responder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-owner-"));
  const socketPath = join(directory, "control.sock");

  try {
    await recordAutomaticResponder(socketPath, "session-a");
    await recordAutomaticResponder(socketPath, "session-b");

    assert.deepEqual(await readResponder(socketPath), {
      mode: "automatic",
      sessionId: "session-b",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pinned responder overrides later automatic activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-owner-"));
  const socketPath = join(directory, "control.sock");

  try {
    await recordAutomaticResponder(socketPath, "session-a");
    await setPinnedResponder(socketPath, "session-pinned");
    await recordAutomaticResponder(socketPath, "session-b");

    assert.deepEqual(await readResponder(socketPath), {
      mode: "pinned",
      sessionId: "session-pinned",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clearing pin restores automatic responder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-owner-"));
  const socketPath = join(directory, "control.sock");

  try {
    await recordAutomaticResponder(socketPath, "session-a");
    await setPinnedResponder(socketPath, "session-pinned");
    await clearPinnedResponder(socketPath);

    assert.deepEqual(await readResponder(socketPath), {
      mode: "automatic",
      sessionId: "session-a",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns no responder when no ownership was recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-owner-"));

  try {
    assert.equal(await readResponder(join(directory, "control.sock")), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
