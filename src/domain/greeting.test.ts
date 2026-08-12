import { describe, expect, it } from "vitest";

import { createGreeting } from "./greeting.js";

describe("createGreeting", () => {
  it("greets a named user", () => {
    expect(createGreeting("Cristian")).toBe("Hello, Cristian!");
  });

  it("greets the world when the name is blank", () => {
    expect(createGreeting("   ")).toBe("Hello, world!");
  });
});
