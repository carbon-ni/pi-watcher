import { describe, expect, it } from "vitest";

import {
  classifyCorrelation,
  CORRELATION_CHECKPOINT_MAX_PATHS,
  normalizeEditPaths,
  recordEditCheckpoint,
} from "./correlation.js";
import type { EditCheckpoint } from "./correlation.js";

const ROOT = "/project";

describe("normalizeEditPaths", () => {
  it("keeps relative paths and converts absolute paths under the root", () => {
    expect(normalizeEditPaths(["src/index.ts", "/project/src/app.ts"], ROOT)).toEqual([
      "src/app.ts",
      "src/index.ts",
    ]);
  });

  it("drops paths outside the trusted project root", () => {
    expect(
      normalizeEditPaths(["/etc/passwd", "/project/../other/file.ts", "/home/user/x.ts"], ROOT),
    ).toEqual([]);
  });

  it("normalizes dot-prefixed relative paths and deduplicates", () => {
    expect(normalizeEditPaths(["./src/a.ts", "src/a.ts", "src/b.ts"], ROOT)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("drops empty and whitespace paths", () => {
    expect(normalizeEditPaths(["", "   ", "src/ok.ts"], ROOT)).toEqual(["src/ok.ts"]);
  });

  it("handles the root itself and trailing slashes", () => {
    expect(normalizeEditPaths(["/project/", "/project/README.md"], "/project/")).toEqual([
      "README.md",
    ]);
  });
});

describe("recordEditCheckpoint", () => {
  const checkpoint = (overrides: Partial<EditCheckpoint> = {}): EditCheckpoint => ({
    instanceToken: "fz-7f3a",
    paths: ["src/a.ts"],
    at: 1_000,
    ...overrides,
  });

  it("starts a fresh checkpoint without a previous one", () => {
    const next = recordEditCheckpoint(null, ["src/a.ts"], "fz-7f3a", 2_000);

    expect(next).toEqual({ instanceToken: "fz-7f3a", paths: ["src/a.ts"], at: 2_000 });
  });

  it("merges paths into a live checkpoint from the same instance", () => {
    const next = recordEditCheckpoint(checkpoint(), ["src/b.ts"], "fz-7f3a", 2_000);

    expect(next.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(next.at).toBe(2_000);
  });

  it("starts fresh when the watcher instance changed", () => {
    const next = recordEditCheckpoint(checkpoint(), ["src/b.ts"], "fz-9b21", 2_000);

    expect(next).toEqual({ instanceToken: "fz-9b21", paths: ["src/b.ts"], at: 2_000 });
  });

  it("starts fresh when the previous checkpoint expired", () => {
    const next = recordEditCheckpoint(
      checkpoint({ at: 1_000 }),
      ["src/b.ts"],
      "fz-7f3a",
      11 * 60_000,
    );

    expect(next.paths).toEqual(["src/b.ts"]);
  });

  it("bounds the checkpoint to the maximum path count", () => {
    const manyPaths = Array.from({ length: 60 }, (_, index) => `src/f${index}.ts`);
    const next = recordEditCheckpoint(null, manyPaths, "fz-7f3a", 2_000);

    expect(next.paths).toHaveLength(CORRELATION_CHECKPOINT_MAX_PATHS);
    expect(next.paths[0]).toBe("src/f10.ts");
  });

  it("deduplicates across merges", () => {
    const next = recordEditCheckpoint(checkpoint(), ["src/a.ts", "src/c.ts"], "fz-7f3a", 2_000);

    expect(next.paths).toEqual(["src/a.ts", "src/c.ts"]);
  });
});

describe("classifyCorrelation", () => {
  const checkpoint = (overrides: Partial<EditCheckpoint> = {}): EditCheckpoint => ({
    instanceToken: "fz-7f3a",
    paths: ["src/index.ts", "src/app.ts"],
    at: 1_000,
    ...overrides,
  });

  it("reports unknown without any session checkpoint", () => {
    expect(classifyCorrelation(null, "fz-7f3a", ["src/index.ts"], ROOT)).toEqual({
      class: "unknown",
      clearedOnInstanceChange: false,
    });
  });

  it("classifies exact overlap when a batch includes a session edit", () => {
    expect(classifyCorrelation(checkpoint(), "fz-7f3a", ["src/index.ts"], ROOT)).toEqual({
      class: "exact-overlap",
      clearedOnInstanceChange: false,
    });
  });

  it("matches normalized absolute batch paths against the root", () => {
    expect(classifyCorrelation(checkpoint(), "fz-7f3a", ["/project/src/index.ts"], ROOT)).toEqual({
      class: "exact-overlap",
      clearedOnInstanceChange: false,
    });
  });

  it("classifies no overlap when the batch excludes every session edit", () => {
    expect(classifyCorrelation(checkpoint(), "fz-7f3a", ["docs/readme.md"], ROOT)).toEqual({
      class: "no-overlap",
      clearedOnInstanceChange: false,
    });
  });

  it("classifies incomplete evidence when the batch carries no paths", () => {
    expect(classifyCorrelation(checkpoint(), "fz-7f3a", [], ROOT)).toEqual({
      class: "incomplete",
      clearedOnInstanceChange: false,
    });
  });

  it("reports unknown and signals clearing when the watcher instance changed", () => {
    expect(classifyCorrelation(checkpoint(), "fz-9b21", ["src/index.ts"], ROOT)).toEqual({
      class: "unknown",
      clearedOnInstanceChange: true,
    });
  });

  it("reports unknown for an empty checkpoint", () => {
    expect(
      classifyCorrelation(checkpoint({ paths: [] }), "fz-7f3a", ["src/index.ts"], ROOT),
    ).toEqual({
      class: "unknown",
      clearedOnInstanceChange: false,
    });
  });

  it("never upgrades to exact overlap on evidence alone (inclusion, not causation)", () => {
    // Overlap is evidence of inclusion; the classifier never claims the edit
    // caused the event.
    expect(classifyCorrelation(checkpoint(), "fz-7f3a", ["src/index.ts"], ROOT).class).toBe(
      "exact-overlap",
    );
  });
});
