import { describe, expect, it } from "vitest";

import { AUTOMATIC_OWNER_TTL_MS, isAutomaticOwnerExpired } from "./ownership.js";

describe("isAutomaticOwnerExpired", () => {
  it("keeps a recent automatic owner", () => {
    expect(isAutomaticOwnerExpired(Date.now() - 60_000, Date.now())).toBe(false);
  });

  it("expires an automatic owner without recent activity", () => {
    expect(isAutomaticOwnerExpired(Date.now() - AUTOMATIC_OWNER_TTL_MS - 1, Date.now())).toBe(true);
  });

  it("keeps an owner active exactly at the boundary", () => {
    expect(isAutomaticOwnerExpired(Date.now() - AUTOMATIC_OWNER_TTL_MS, Date.now())).toBe(false);
  });
});
