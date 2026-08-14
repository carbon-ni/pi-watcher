import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  boundOutputLines,
  decodeWatcherOutput,
  formatWatcherOutput,
  WatcherProtocolError,
} from "./output.js";
import type { WatcherOutputRequest, WatcherOutputResult } from "./output.js";

async function goldenResult(): Promise<WatcherOutputResult> {
  const fixture = await readFile(join(import.meta.dirname, "fixtures", "output.json"), "utf8");
  return decodeWatcherOutput(JSON.parse(fixture));
}

const FULL: WatcherOutputResult = {
  generation: 7,
  task: "lint",
  stream: "stdout",
  observedBytes: 8192,
  retainedBytes: 4096,
  evicted: false,
  truncated: false,
  lines: ["line one", "line two", "line three", "line four", "line five"],
};

describe("decodeWatcherOutput", () => {
  it("decodes the golden output fixture", async () => {
    const result = await goldenResult();

    expect(result).toEqual({
      generation: 7,
      task: "lint",
      stream: "stdout",
      observedBytes: 8192,
      retainedBytes: 4096,
      evicted: false,
      truncated: true,
      lines: ["failure: boom", "  at src/main.rs:12"],
    });
  });

  it("accepts a whole-generation result with no task or stream identity", async () => {
    const result = decodeWatcherOutput({
      generation: 7,
      task: null,
      stream: null,
      observedBytes: 0,
      retainedBytes: 0,
      evicted: true,
      truncated: false,
      lines: [],
    });

    expect(result.task).toBeNull();
    expect(result.stream).toBeNull();
    expect(result.evicted).toBe(true);
  });

  it("distinguishes concurrent task identities within one generation", () => {
    const taskA = decodeWatcherOutput({ ...FULL, task: "lint", observedBytes: 1024 });
    const taskB = decodeWatcherOutput({ ...FULL, task: "test", observedBytes: 2048 });

    expect(formatWatcherOutput(taskA).split("\n")[0]).toMatch(
      /task=lint stream=stdout retained=4096 observed=1024/,
    );
    expect(formatWatcherOutput(taskB).split("\n")[0]).toMatch(
      /task=test stream=stdout retained=4096 observed=2048/,
    );
    expect(taskA).not.toEqual(taskB);
  });

  it("rejects a missing generation", () => {
    expect(() =>
      decodeWatcherOutput({
        task: null,
        stream: null,
        observedBytes: 0,
        retainedBytes: 0,
        evicted: false,
        truncated: false,
        lines: [],
      }),
    ).toThrow(WatcherProtocolError);
  });

  it("rejects a non-string line (non-UTF8 payloads fail closed)", () => {
    expect(() =>
      decodeWatcherOutput({
        generation: 7,
        task: null,
        stream: null,
        observedBytes: 0,
        retainedBytes: 0,
        evicted: false,
        truncated: false,
        lines: ["ok", 42],
      }),
    ).toThrow(/line at index 1 must be a string/);
  });

  it("rejects an unknown stream value", () => {
    expect(() =>
      decodeWatcherOutput({
        generation: 7,
        task: null,
        stream: "telemetry",
        observedBytes: 0,
        retainedBytes: 0,
        evicted: false,
        truncated: false,
        lines: [],
      }),
    ).toThrow(/stream/);
  });
});

describe("boundOutputLines", () => {
  it("keeps the last 40 lines by default and marks truncation", () => {
    const manyLines = Array.from({ length: 46 }, (_, index) => `line ${index}`);
    const request: WatcherOutputRequest = { generation: 7 };

    const result = boundOutputLines({ ...FULL, lines: manyLines }, request);

    expect(result.lines).toHaveLength(40);
    expect(result.lines[0]).toBe("line 6");
    expect(result.truncated).toBe(true);
  });

  it("honors an explicit tail", () => {
    const request: WatcherOutputRequest = { generation: 7, tail: 2 };

    const result = boundOutputLines(FULL, request);

    expect(result.lines).toEqual(["line four", "line five"]);
    expect(result.truncated).toBe(true);
  });

  it("returns every retained line in full mode without client truncation", () => {
    const request: WatcherOutputRequest = { generation: 7, full: true };

    const result = boundOutputLines(FULL, request);

    expect(result.lines).toEqual(FULL.lines);
    expect(result.truncated).toBe(false);
  });

  it("keeps server-side truncation visible in full mode", () => {
    const request: WatcherOutputRequest = { generation: 7, full: true };

    const result = boundOutputLines({ ...FULL, truncated: true }, request);

    expect(result.lines).toEqual(FULL.lines);
    expect(result.truncated).toBe(true);
  });

  it("returns zero lines for a zero tail", () => {
    const request: WatcherOutputRequest = { generation: 7, tail: 0 };

    const result = boundOutputLines(FULL, request);

    expect(result.lines).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("leaves a short default tail untruncated", () => {
    const request: WatcherOutputRequest = { generation: 7 };

    const result = boundOutputLines(FULL, request);

    expect(result.lines).toEqual(FULL.lines);
    expect(result.truncated).toBe(false);
  });
});

describe("formatWatcherOutput", () => {
  it("reports the exact selected identity and byte counts", () => {
    expect(formatWatcherOutput(FULL).split("\n")[0]).toBe(
      "OUTPUT gen=7 task=lint stream=stdout retained=4096 observed=8192",
    );
  });

  it("preserves line boundaries without terminal-width dependence", () => {
    const text = formatWatcherOutput(FULL);

    expect(text).toBe(
      "OUTPUT gen=7 task=lint stream=stdout retained=4096 observed=8192\n" +
        "  line one\n  line two\n  line three\n  line four\n  line five",
    );
  });

  it("labels eviction explicitly", () => {
    const text = formatWatcherOutput({ ...FULL, evicted: true, retainedBytes: 0, lines: [] });

    expect(text).toBe("OUTPUT gen=7 task=lint stream=stdout retained=0 observed=8192 evicted");
  });

  it("labels truncation explicitly", () => {
    const text = formatWatcherOutput({ ...FULL, truncated: true });

    expect(text.split("\n")[0]).toMatch(/ truncated$/);
  });

  it("renders whole-generation and both-stream identities as all", () => {
    expect(formatWatcherOutput({ ...FULL, task: null, stream: null }).split("\n")[0]).toBe(
      "OUTPUT gen=7 task=all stream=all retained=4096 observed=8192",
    );
  });
});
