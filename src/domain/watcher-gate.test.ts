import { describe, expect, it } from "vitest";

import { exposesWatcherTools, WATCHER_TOOL_NAMES } from "./watcher-gate.js";

describe("exposesWatcherTools", () => {
  it("keeps the surface closed when no contract file exists", () => {
    expect(exposesWatcherTools({ watchYaml: false, watchYml: false })).toBe(false);
  });

  it("opens the surface for .watch.yaml alone", () => {
    expect(exposesWatcherTools({ watchYaml: true, watchYml: false })).toBe(true);
  });

  it("opens the surface for .watch.yml alone", () => {
    expect(exposesWatcherTools({ watchYaml: false, watchYml: true })).toBe(true);
  });

  it("opens the surface when both contract files exist", () => {
    expect(exposesWatcherTools({ watchYaml: true, watchYml: true })).toBe(true);
  });

  it("keeps the canonical watcher tool surface (compatibility contract)", () => {
    expect([...WATCHER_TOOL_NAMES]).toEqual([
      "watcher_status",
      "watcher_targets",
      "watcher_observe",
      "watcher_output",
      "watcher_cancel",
      "watcher_verify",
    ]);
    expect(new Set(WATCHER_TOOL_NAMES).size).toBe(WATCHER_TOOL_NAMES.length);
  });
});
