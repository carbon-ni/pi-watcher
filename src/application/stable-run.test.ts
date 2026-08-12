import assert from "node:assert/strict";
import { test } from "vitest";

import type { WatcherStatus } from "../domain/watcher.js";
import { requestStableRun, waitForRun } from "./stable-run.js";

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

test("retries a superseded verification while worktree stays unchanged", async () => {
  const requestedRuns: number[] = [];
  const statuses = [
    { ...passed, generation: 2, state: "running" as const },
    { ...passed, generation: 3, state: "running" as const },
    { ...passed, generation: 4, state: "running" as const },
    { ...passed, generation: 4 },
  ];
  let nextRun = 2;

  const result = await requestStableRun({
    timeoutMs: 500,
    pollIntervalMs: 1,
    request: async () => {
      requestedRuns.push(nextRun);
      return nextRun++;
    },
    readStatus: async () => statuses.shift() ?? { ...passed, generation: 4 },
    isWorktreeCurrent: async () => true,
  });

  assert.equal(result.generation, 4);
  assert.deepEqual(requestedRuns, [2, 3, 4]);
});

test("stops retrying a superseded verification when worktree changes", async () => {
  await assert.rejects(
    () =>
      requestStableRun({
        timeoutMs: 500,
        pollIntervalMs: 1,
        request: async () => 2,
        readStatus: async () => ({ ...passed, generation: 3, state: "running" as const }),
        isWorktreeCurrent: async () => false,
      }),
    /worktree changed while Funzzy verification was running/,
  );
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
