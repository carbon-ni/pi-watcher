import assert from "node:assert/strict";
import { test } from "vitest";
import type { WatcherStatus } from "./watcher.js";
import { createFailureNotifier } from "./failure-notifier.js";

const failed: WatcherStatus = {
  generation: 7,
  state: "failed",
  trigger: "src/main.ts",
  commands: ["npm test"],
  durationMs: 42,
  failures: ["npm test exited with status 1"],
};

test("sends each owned failed generation once when the agent is idle", () => {
  const sent: WatcherStatus[] = [];
  const notify = createFailureNotifier("session-a", (status) => sent.push(status));

  assert.equal(notify(failed, true, "session-a"), true);
  assert.equal(notify(failed, true, "session-a"), false);
  assert.deepEqual(sent, [failed]);
});

test("holds an owned failure until the agent becomes idle", () => {
  const sent: WatcherStatus[] = [];
  const notify = createFailureNotifier("session-a", (status) => sent.push(status));

  assert.equal(notify(failed, false, "session-a"), false);
  assert.equal(notify(failed, true, "session-a"), true);
  assert.deepEqual(sent, [failed]);
});

test("does not send non-failure status into agent context", () => {
  const sent: WatcherStatus[] = [];
  const notify = createFailureNotifier("session-a", (status) => sent.push(status));

  assert.equal(notify({ ...failed, state: "passed", failures: [] }, true, "session-a"), false);
  assert.deepEqual(sent, []);
});

test("does not send a failure owned by another agent", () => {
  const sent: WatcherStatus[] = [];
  const notify = createFailureNotifier("session-b", (status) => sent.push(status));

  assert.equal(notify(failed, true, "session-a"), false);
  assert.deepEqual(sent, []);
});
