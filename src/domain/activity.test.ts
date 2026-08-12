import assert from "node:assert/strict";
import { test } from "vitest";
import { recordsAgentActivity } from "./activity.js";

test("records tools that may change the worktree", () => {
  assert.equal(recordsAgentActivity("edit"), true);
  assert.equal(recordsAgentActivity("write"), true);
  assert.equal(recordsAgentActivity("bash"), true);
});

test("does not claim ownership for read-only tools", () => {
  assert.equal(recordsAgentActivity("read"), false);
  assert.equal(recordsAgentActivity("watcher_status"), false);
});
