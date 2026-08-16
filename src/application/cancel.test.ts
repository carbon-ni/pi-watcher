import { describe, expect, it, vi } from "vitest";

import { requestCancellation, type CancelPort } from "./cancel.js";
import type { CancellationOutcome } from "../domain/cancel.js";

describe("requestCancellation", () => {
  const OUTCOMES: CancellationOutcome[] = [
    "cancelled",
    "not-running",
    "escalated",
    "timeout",
    "disconnect",
    "unknown",
  ];

  it("passes the exact generation and bounded acknowledgement wait to the port", async () => {
    const cancel = vi.fn().mockResolvedValue({ outcome: "cancelled", message: null });
    const port: CancelPort = { cancel };

    const result = await requestCancellation({ generation: 7, timeoutMs: 3_000 }, { port });

    expect(cancel).toHaveBeenCalledWith({ generation: 7, timeoutMs: 3_000 });
    expect(result).toEqual({ outcome: "cancelled", generation: 7, message: null });
  });

  it("defaults the acknowledgement wait and carries the generation in the result", async () => {
    const port: CancelPort = {
      cancel: async () => ({ outcome: "not-running", message: null }),
    };

    const result = await requestCancellation({ generation: 7 }, { port });

    expect(result).toEqual({ outcome: "not-running", generation: 7, message: null });
  });

  it("surfaces every port outcome unchanged", async () => {
    for (const outcome of OUTCOMES) {
      const port: CancelPort = {
        cancel: async () => ({ outcome, message: null }),
      };

      const result = await requestCancellation({ generation: 7 }, { port });

      expect(result.outcome).toBe(outcome);
    }
  });

  it("attaches the port message to unknown outcomes", async () => {
    const port: CancelPort = {
      cancel: async () => ({ outcome: "unknown", message: "boom" }),
    };

    const result = await requestCancellation({ generation: 7 }, { port });

    expect(result).toEqual({ outcome: "unknown", generation: 7, message: "boom" });
  });
});
