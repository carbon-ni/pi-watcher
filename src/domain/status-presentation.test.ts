import { describe, expect, it } from "vitest";

import { renderWatcherFooter, watcherStatusColor } from "./status-presentation.js";
import type { WatcherStatus } from "./watcher.js";

const status: WatcherStatus = {
  generation: 7,
  state: "passed",
  trigger: "src/index.ts",
  commands: ["make all"],
  durationMs: 42,
  failures: [],
};

describe("renderWatcherFooter", () => {
  it("uses watcher terminology in status bar", () => {
    expect(renderWatcherFooter(status)).toBe("watcher: passed #7 42ms");
  });

  it("omits unavailable duration", () => {
    expect(renderWatcherFooter({ ...status, durationMs: null })).toBe("watcher: passed #7");
  });

  it.each([
    ["passed", "success"],
    ["failed", "error"],
    ["running", "accent"],
    ["idle", "muted"],
    ["cancelled", "warning"],
  ] as const)("maps %s status to %s color", (state, color) => {
    expect(watcherStatusColor(state)).toBe(color);
  });
});
