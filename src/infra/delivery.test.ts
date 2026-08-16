import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { claimFailureDelivery } from "./delivery.js";

async function withDeliveryDir(run: (socketPath: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "funzzy-delivery-"));
  const socketPath = join(directory, "control.sock");
  try {
    await run(socketPath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("first claim wins and the same key cannot be claimed twice", async () => {
  await withDeliveryDir(async (socketPath) => {
    assert.equal(await claimFailureDelivery(socketPath, "fz-7f3a:7"), true);
    assert.equal(await claimFailureDelivery(socketPath, "fz-7f3a:7"), false);
  });
});

test("different delivery keys claim independently", async () => {
  await withDeliveryDir(async (socketPath) => {
    assert.equal(await claimFailureDelivery(socketPath, "fz-7f3a:7"), true);
    assert.equal(await claimFailureDelivery(socketPath, "fz-7f3a:8"), true);
  });
});

test("the claim survives across sessions and adapters", async () => {
  await withDeliveryDir(async (socketPath) => {
    assert.equal(await claimFailureDelivery(socketPath, "fz-7f3a:7"), true);
    // A second session (fresh claim call, same backing files) sees the claim.
    assert.equal(await claimFailureDelivery(socketPath, "fz-7f3a:7"), false);
  });
});

test("expired claims are pruned by a later claim", async () => {
  await withDeliveryDir(async (socketPath, directory) => {
    const stalePath = join(directory, ".pi-funzzy-delivered-stale-key.json");
    await writeFile(
      stalePath,
      `${JSON.stringify({ v: 1, key: "stale-key", deliveredAt: Date.now() - 3_660_000 })}\n`,
      { flag: "wx", mode: 0o600 },
    );

    await claimFailureDelivery(socketPath, "fz-7f3a:9");

    const files = await readdir(directory);
    assert.ok(!files.includes(".pi-funzzy-delivered-stale-key.json"));
    assert.ok(
      files.some((file) => file.includes("pi-funzzy-delivered") && !file.includes("stale-key")),
    );
  });
});

test("a malformed claim file fails closed without blocking delivery", async () => {
  await withDeliveryDir(async (socketPath, directory) => {
    const badPath = join(directory, ".pi-funzzy-delivered-bad.json");
    await writeFile(badPath, "not json\n", { flag: "wx", mode: 0o600 });

    assert.equal(await claimFailureDelivery(socketPath, "fz-7f3a:10"), true);
    const files = await readdir(directory);
    assert.ok(files.includes(".pi-funzzy-delivered-bad.json"));
    // Fresh claim for the same key still wins; the malformed file uses a
    // different key so it cannot block delivery.
    const claims = files.filter((file) => file.includes("fz-7f3a-10"));
    assert.equal(claims.length, 1);
    const raw = await readFile(join(directory, claims[0]!), "utf8");
    assert.match(raw, /"key":"fz-7f3a:10"/);
  });
});
