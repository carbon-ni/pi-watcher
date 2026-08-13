import assert from "node:assert/strict";
import { test } from "vitest";

import type { WatcherStatus } from "../domain/watcher.js";
import { waitForRun } from "./stable-run.js";

const passed: WatcherStatus = {
  generation: 4,
  state: "passed",
  trigger: "src/main.rs",
  commands: ["cargo test"],
  durationMs: 42,
  failures: [],
};

test("reports periodic updates while waiting for a run", async () => {
  const updates: number[] = [];
  let calls = 0;
  const statusReader = async () => {
    calls += 1;
    if (calls < 3) return { ...passed, generation: 7, state: "running" as const };
    return { ...passed, generation: 7 };
  };

  const result = await waitForRun(
    7,
    500,
    statusReader,
    1,
    (status) => {
      updates.push(status.generation);
    },
    0,
  );

  assert.equal(result.state, "passed");
  assert.deepEqual(updates, [7, 7]);
});

test("waits for requested run instead of accepting older pass", async () => {
  let calls = 0;
  const statusReader = async () => {
    calls += 1;
    if (calls === 1) return { ...passed, generation: 6 };
    if (calls === 2) return { ...passed, generation: 7, state: "running" as const };
    return { ...passed, generation: 7 };
  };

  const result = await waitForRun(7, 500, statusReader, 1);
  assert.equal(result.generation, 7);
  assert.equal(result.state, "passed");
  assert.equal(calls, 3);
});
