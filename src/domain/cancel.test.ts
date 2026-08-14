import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  cancellationReport,
  decodeWatcherCancel,
  formatCancellation,
  WatcherProtocolError,
} from "./cancel.js";
import type { WatcherCancelResult } from "./cancel.js";

describe("decodeWatcherCancel", () => {
  it("decodes the golden cancel fixture as a graceful acknowledgement", async () => {
    const fixture = await readFile(join(import.meta.dirname, "fixtures", "cancel.json"), "utf8");

    expect(decodeWatcherCancel(JSON.parse(fixture))).toEqual({ cancelled: true, generation: 7 });
  });

  it("decodes a no-op acknowledgement", () => {
    expect(decodeWatcherCancel({ cancelled: false, generation: 7 })).toEqual({
      cancelled: false,
      generation: 7,
    });
  });

  it("rejects a missing generation", () => {
    expect(() => decodeWatcherCancel({ cancelled: true })).toThrow(WatcherProtocolError);
  });

  it("rejects a non-boolean cancelled flag", () => {
    expect(() => decodeWatcherCancel({ cancelled: "yes", generation: 7 })).toThrow(/cancelled/);
  });
});

describe("formatCancellation", () => {
  it("renders a graceful cancellation", () => {
    expect(formatCancellation({ outcome: "cancelled", generation: 7, message: null })).toBe(
      "CANCEL gen=7 cancelled",
    );
  });

  it("renders a no-op when the generation is not running", () => {
    expect(formatCancellation({ outcome: "not-running", generation: 7, message: null })).toBe(
      "CANCEL gen=7 not-running",
    );
  });

  it("renders an escalated cleanup", () => {
    expect(formatCancellation({ outcome: "escalated", generation: 7, message: null })).toBe(
      "CANCEL gen=7 escalated",
    );
  });

  it("renders timeout, disconnect, and unknown with a message", () => {
    expect(formatCancellation({ outcome: "timeout", generation: 7, message: null })).toBe(
      "CANCEL gen=7 timeout",
    );
    expect(formatCancellation({ outcome: "disconnect", generation: 7, message: null })).toBe(
      "CANCEL gen=7 disconnect",
    );
    expect(
      formatCancellation({
        outcome: "unknown",
        generation: 7,
        message: "Funzzy RPC error -32601: Method not found",
      }),
    ).toBe("CANCEL gen=7 unknown message=Funzzy RPC error -32601: Method not found");
  });
});

describe("cancellation report", () => {
  const reports: Array<[WatcherCancelResult["outcome"], string]> = [
    ["cancelled", "cleanup=cancelled"],
    ["not-running", "cleanup=none"],
    ["escalated", "cleanup=escalated"],
    ["timeout", "cleanup=unknown"],
    ["disconnect", "cleanup=unknown"],
    ["unknown", "cleanup=unknown"],
  ];

  it("maps every outcome to a compact cleanup report", () => {
    for (const [outcome, expected] of reports) {
      expect(cancellationReport({ outcome, generation: 7, message: null })).toBe(expected);
    }
  });

  it("reports no cancellation when no cancel was attempted", () => {
    expect(cancellationReport(null)).toBe("cleanup=none");
  });
});
