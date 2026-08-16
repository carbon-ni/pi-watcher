import { describe, expect, it } from "vitest";

import { formatTargets } from "./targets-presentation.js";
import type { WatcherTarget } from "./watcher.js";

describe("formatTargets", () => {
  it("renders a friendly message when no targets are configured", () => {
    expect(formatTargets([])).toBe("No Funzzy targets configured");
  });

  it("renders each target name with its joined commands", () => {
    const targets: WatcherTarget[] = [
      { name: "lint", commands: ["npm run lint"] },
      { name: "check", commands: ["npm run format", "make tests"] },
    ];

    expect(formatTargets(targets)).toBe(
      "- lint: npm run lint\n- check: npm run format && make tests",
    );
  });

  it("renders a useful measured estimate without exposing implementation detail", () => {
    const targets: WatcherTarget[] = [
      {
        name: "check",
        commands: ["make tests"],
        estimate: {
          typicalMs: 38_000,
          upperMs: 61_000,
          recommendedTimeoutMs: 95_000,
          samples: 12,
          confidence: "high",
          source: "measured",
        },
      },
    ];

    expect(formatTargets(targets)).toBe(
      "- check: make tests (estimate typical=38s upper=61s timeout=95s high n=12)",
    );
  });
});
