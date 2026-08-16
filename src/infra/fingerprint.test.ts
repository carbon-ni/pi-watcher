import assert from "node:assert/strict";
import { test } from "vitest";
import { fingerprintParts } from "./fingerprint.js";

test("fingerprint is deterministic regardless of untracked file order", () => {
  const first = fingerprintParts("patch", [
    ["b.txt", Buffer.from("b")],
    ["a.txt", Buffer.from("a")],
  ]);
  const second = fingerprintParts("patch", [
    ["a.txt", Buffer.from("a")],
    ["b.txt", Buffer.from("b")],
  ]);
  assert.equal(first, second);
});

test("fingerprint changes with tracked or untracked content", () => {
  const original = fingerprintParts("patch", [["a.txt", Buffer.from("a")]]);
  assert.notEqual(original, fingerprintParts("other patch", [["a.txt", Buffer.from("a")]]));
  assert.notEqual(original, fingerprintParts("patch", [["a.txt", Buffer.from("b")]]));
});
