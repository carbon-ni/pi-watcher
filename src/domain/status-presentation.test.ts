import { describe, expect, it } from "vitest";

import {
  renderWatcherFooter,
  rightAlignWatcherText,
  WATCHER_WIDGET_OPTIONS,
  watcherStatusColor,
} from "./status-presentation.js";
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

  it("places watcher below editor", () => {
    expect(WATCHER_WIDGET_OPTIONS).toEqual({ placement: "belowEditor" });
  });

  it("right-aligns status text within available width", () => {
    expect(rightAlignWatcherText("watcher: passed", 20)).toBe("     watcher: passed");
  });

  it("clips status text to narrow available width", () => {
    expect(rightAlignWatcherText("watcher: passed", 8)).toBe("watcher:");
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
