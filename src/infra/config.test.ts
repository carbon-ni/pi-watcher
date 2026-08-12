import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { readConfig } from "./config.js";

test("returns null when project has no Funzzy configuration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "funzzy-config-"));
  try {
    assert.equal(await readConfig(cwd), null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reads the shared socket path from .watch.yaml", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "funzzy-config-"));
  await writeFile(join(cwd, ".watch.yaml"), "on:\n  socket: .tmp/funzzy/control.sock\ntasks: []\n");

  try {
    assert.deepEqual(await readConfig(cwd), {
      socketPath: join(cwd, ".tmp/funzzy/control.sock"),
      pollIntervalMs: 1000,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects a non-string on.socket", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "funzzy-config-"));
  await writeFile(join(cwd, ".watch.yaml"), "on:\n  socket: 42\ntasks: []\n");

  try {
    await assert.rejects(() => readConfig(cwd), /on\.socket/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
