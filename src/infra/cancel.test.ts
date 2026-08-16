import { describe, expect, it } from "vitest";

import { createCancelPort } from "./cancel.js";
import { FunzzyDisconnectError, FunzzyRequestTimeoutError, FunzzyRpcError } from "./client.js";

describe("createCancelPort", () => {
  it("reports cancelled on a graceful compare-and-cancel acknowledgement", async () => {
    const port = createCancelPort({
      socketPath: "/tmp/funzzy.sock",
      instanceToken: "fz-7f3a",
      requestCancel: async () => ({ cancelled: true, generation: 7 }),
    });

    await expect(port.cancel({ generation: 7, timeoutMs: 500 })).resolves.toEqual({
      outcome: "cancelled",
      message: null,
    });
  });

  it("reports not-running when nothing matched the exact generation", async () => {
    const port = createCancelPort({
      socketPath: "/tmp/funzzy.sock",
      instanceToken: "fz-7f3a",
      requestCancel: async () => ({ cancelled: false, generation: 7 }),
    });

    await expect(port.cancel({ generation: 7, timeoutMs: 500 })).resolves.toEqual({
      outcome: "not-running",
      message: null,
    });
  });

  it("reports escalated when the server had to force cleanup", async () => {
    const port = createCancelPort({
      socketPath: "/tmp/funzzy.sock",
      instanceToken: "fz-7f3a",
      requestCancel: async () => {
        throw new FunzzyRpcError(-32021, "Cancellation escalated", { escalation: true });
      },
    });

    await expect(port.cancel({ generation: 7, timeoutMs: 500 })).resolves.toEqual({
      outcome: "escalated",
      message: null,
    });
  });

  it("reports disconnect when the transport dropped", async () => {
    const port = createCancelPort({
      socketPath: "/tmp/funzzy.sock",
      instanceToken: "fz-7f3a",
      requestCancel: async () => {
        throw new FunzzyDisconnectError("Funzzy unavailable after 500ms");
      },
    });

    const result = await port.cancel({ generation: 7, timeoutMs: 500 });
    expect(result.outcome).toBe("disconnect");
    expect(result.message).toMatch(/unavailable/);
  });

  it("reports timeout when no acknowledgement arrived in time", async () => {
    const port = createCancelPort({
      socketPath: "/tmp/funzzy.sock",
      instanceToken: "fz-7f3a",
      requestCancel: async () => {
        throw new FunzzyRequestTimeoutError("Funzzy request timed out after 500ms");
      },
    });

    const result = await port.cancel({ generation: 7, timeoutMs: 500 });
    expect(result.outcome).toBe("timeout");
    expect(result.message).toMatch(/timed out/);
  });

  it("reports unknown on malformed payloads or unexpected errors", async () => {
    const port = createCancelPort({
      socketPath: "/tmp/funzzy.sock",
      instanceToken: "fz-7f3a",
      requestCancel: async () => {
        throw new Error("socket gone");
      },
    });

    await expect(port.cancel({ generation: 7, timeoutMs: 500 })).resolves.toEqual({
      outcome: "unknown",
      message: "socket gone",
    });
  });
});
