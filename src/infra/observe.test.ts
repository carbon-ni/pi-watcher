import { describe, expect, it } from "vitest";

import { classifyObservationError } from "./observe.js";
import { FunzzyDisconnectError, FunzzyRequestTimeoutError, FunzzyRpcError } from "./client.js";
import { WatcherProtocolError } from "../domain/protocol.js";

describe("classifyObservationError", () => {
  it("classifies typed disconnect errors as disconnect", () => {
    expect(
      classifyObservationError(new FunzzyDisconnectError("Funzzy unavailable after 1000ms")),
    ).toBe("disconnect");
    expect(
      classifyObservationError(
        new FunzzyRequestTimeoutError("Funzzy request timed out after 1000ms"),
      ),
    ).toBe("disconnect");
  });

  it("classifies transport-level message patterns as disconnect", () => {
    expect(classifyObservationError(new Error("connect ECONNREFUSED /tmp/funzzy.sock"))).toBe(
      "disconnect",
    );
    expect(classifyObservationError(new Error("read ECONNRESET"))).toBe("disconnect");
    expect(classifyObservationError(new Error("Funzzy response exceeded 64KB"))).toBe("disconnect");
    expect(
      classifyObservationError(new Error("Funzzy closed the socket without a complete response")),
    ).toBe("disconnect");
  });

  it("classifies malformed or unsupported server payloads as unknown", () => {
    expect(
      classifyObservationError(
        new WatcherProtocolError('Funzzy correlated snapshot: "generation" must be a number'),
      ),
    ).toBe("unknown");
    expect(classifyObservationError(new FunzzyRpcError(-32601, "Method not found"))).toBe(
      "unknown",
    );
    expect(
      classifyObservationError(new Error("Funzzy subscription sent invalid JSON: garbage")),
    ).toBe("unknown");
    expect(
      classifyObservationError(new Error("Funzzy subscription sent an unexpected message: {nope}")),
    ).toBe("unknown");
  });

  it("never guesses on unrecognized errors", () => {
    expect(classifyObservationError(new Error("socket gone"))).toBe("unknown");
    expect(classifyObservationError("not an error")).toBe("unknown");
    expect(classifyObservationError(undefined)).toBe("unknown");
  });

  it("does not misread RPC error data mentioning transport words", () => {
    expect(
      classifyObservationError(
        new Error("Funzzy RPC error -32000: Server error (target execution is unavailable)"),
      ),
    ).toBe("unknown");
  });
});
