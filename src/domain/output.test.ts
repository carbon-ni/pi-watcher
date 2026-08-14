import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodeWatcherOutput, formatWatcherOutput, WatcherProtocolError } from "./output.js";
import type { WatcherOutputResult } from "./output.js";

async function goldenResult(): Promise<WatcherOutputResult> {
  const fixture = await readFile(join(import.meta.dirname, "fixtures", "output.json"), "utf8");
  return decodeWatcherOutput(JSON.parse(fixture));
}

const FULL: WatcherOutputResult = {
  generation: 7,
  tasks: [
    {
      id: "lint",
      stdout: {
        content: "line one\nline two\nline three\nline four\nline five\n",
        lines: 5,
        retainedBytes: 4096,
        observedBytes: 8192,
        truncated: false,
      },
      stderr: null,
    },
  ],
};

describe("decodeWatcherOutput", () => {
  it("decodes the golden output fixture", async () => {
    const result = await goldenResult();

    expect(result).toEqual({
      generation: 7,
      tasks: [
        {
          id: "lint",
          stdout: {
            content: "failure: boom\n  at src/main.rs:12\n",
            lines: 2,
            retainedBytes: 4096,
            observedBytes: 8192,
            truncated: true,
          },
          stderr: null,
        },
        {
          id: "test",
          stdout: null,
          stderr: {
            content: "error: nope\n",
            lines: 1,
            retainedBytes: 13,
            observedBytes: 13,
            truncated: false,
          },
        },
      ],
    });
  });

  it("accepts a whole-generation result with multiple retained tasks", async () => {
    const result = decodeWatcherOutput({
      generation: 3,
      tasks: [
        {
          id: "a",
          stdout: {
            content: "ok\n",
            lines: 1,
            retainedBytes: 3,
            observedBytes: 3,
            truncated: false,
          },
          stderr: null,
        },
        {
          id: "b",
          stdout: null,
          stderr: {
            content: "err\n",
            lines: 1,
            retainedBytes: 4,
            observedBytes: 4,
            truncated: false,
          },
        },
      ],
    });

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map((task) => task.id)).toEqual(["a", "b"]);
  });

  it("accepts empty streams as null without an explicit value", () => {
    const result = decodeWatcherOutput({
      generation: 1,
      tasks: [{ id: "solo", stdout: null, stderr: null }],
    });

    expect(result.tasks[0]!.stdout).toBeNull();
    expect(result.tasks[0]!.stderr).toBeNull();
  });

  it("rejects a missing generation", () => {
    expect(() => decodeWatcherOutput({ tasks: [] })).toThrow(WatcherProtocolError);
    expect(() => decodeWatcherOutput({ tasks: [] })).toThrow(/generation/);
  });

  it("rejects a missing tasks array", () => {
    expect(() => decodeWatcherOutput({ generation: 1 })).toThrow(/tasks/);
  });

  it("rejects a malformed task entry without an id", () => {
    expect(() =>
      decodeWatcherOutput({ generation: 1, tasks: [{ stdout: null, stderr: null }] }),
    ).toThrow(/output task at index 0: "id" is required/);
  });

  it("rejects a non-string stream content (non-UTF8 payloads fail closed)", () => {
    expect(() =>
      decodeWatcherOutput({
        generation: 1,
        tasks: [
          {
            id: "x",
            stdout: { content: 42, lines: 1, retainedBytes: 1, observedBytes: 1, truncated: false },
            stderr: null,
          },
        ],
      }),
    ).toThrow(/output task at index 0 "stdout": "content" must be a string/);
  });

  it("rejects a stream without truncated", () => {
    expect(() =>
      decodeWatcherOutput({
        generation: 1,
        tasks: [
          {
            id: "x",
            stdout: { content: "a\n", lines: 1, retainedBytes: 1, observedBytes: 1 },
            stderr: null,
          },
        ],
      }),
    ).toThrow(/output task at index 0 "stdout": "truncated" is required/);
  });
});

describe("formatWatcherOutput", () => {
  it("reports the exact task, stream, and byte counts", () => {
    expect(formatWatcherOutput(FULL).split("\n")[0]).toBe(
      "OUTPUT gen=7 task=lint stream=stdout retained=4096 observed=8192",
    );
  });

  it("preserves line boundaries without terminal-width dependence", () => {
    const text = formatWatcherOutput(FULL);

    expect(text).toContain("\n  line one\n  line two\n  line three\n  line four\n  line five");
  });

  it("renders one block per task and stream for whole-generation retrieval", () => {
    const text = formatWatcherOutput({
      generation: 7,
      tasks: [
        {
          id: "lint",
          stdout: {
            content: "ok\n",
            lines: 1,
            retainedBytes: 3,
            observedBytes: 3,
            truncated: false,
          },
          stderr: null,
        },
        {
          id: "test",
          stdout: null,
          stderr: {
            content: "err\n",
            lines: 1,
            retainedBytes: 4,
            observedBytes: 4,
            truncated: true,
          },
        },
      ],
    });

    expect(text).toContain("task=lint stream=stdout");
    expect(text).toContain("task=test stream=stderr");
    expect(text).toContain("truncated");
  });

  it("labels truncation explicitly", () => {
    const text = formatWatcherOutput({
      ...FULL,
      tasks: [
        {
          id: "lint",
          stdout: {
            content: "a\n",
            lines: 1,
            retainedBytes: 4096,
            observedBytes: 8192,
            truncated: true,
          },
          stderr: null,
        },
      ],
    });

    expect(text.split("\n")[0]).toMatch(/ truncated$/);
  });

  it("renders an empty header for a task with no retained content", () => {
    const text = formatWatcherOutput({
      generation: 7,
      tasks: [
        {
          id: "lint",
          stdout: { content: "", lines: 0, retainedBytes: 0, observedBytes: 0, truncated: false },
          stderr: null,
        },
      ],
    });

    expect(text).toBe("OUTPUT gen=7 task=lint stream=stdout retained=0 observed=0");
  });

  it("renders a zero-task header when nothing was retained", () => {
    expect(formatWatcherOutput({ generation: 9, tasks: [] })).toBe("OUTPUT gen=9 tasks=0");
  });
});
