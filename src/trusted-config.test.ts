import { describe, expect, it, vi } from "vitest";

import { createRequireTrustedConfig, TrustedConfigError } from "./trusted-config.js";
import type { FunzzyConfig } from "./infra/config.js";

const CONFIG: FunzzyConfig = { socketPath: "/tmp/funzzy.sock", pollIntervalMs: 1_000 };

function trustedCtx(trusted: boolean) {
  return { cwd: "/project", isProjectTrusted: () => trusted };
}

describe("requireTrustedConfig", () => {
  it("returns the resolved config when the project is trusted and configured", async () => {
    const readConfig = vi.fn().mockResolvedValue(CONFIG);
    const requireTrustedConfig = createRequireTrustedConfig(readConfig);

    await expect(requireTrustedConfig(trustedCtx(true))).resolves.toEqual(CONFIG);
    expect(readConfig).toHaveBeenCalledWith("/project");
  });

  it("rejects untrusted projects without reading config", async () => {
    const readConfig = vi.fn();
    const requireTrustedConfig = createRequireTrustedConfig(readConfig);

    const error = await requireTrustedConfig(trustedCtx(false)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TrustedConfigError);
    expect((error as TrustedConfigError).kind).toBe("untrusted");
    expect((error as TrustedConfigError).message).toBe(
      "Funzzy project configuration is not trusted",
    );
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("rejects projects without on.socket config and names the project path", async () => {
    const readConfig = vi.fn().mockResolvedValue(null);
    const requireTrustedConfig = createRequireTrustedConfig(readConfig);

    const error = await requireTrustedConfig(trustedCtx(true)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TrustedConfigError);
    expect((error as TrustedConfigError).kind).toBe("not-configured");
    expect((error as TrustedConfigError).message).toBe(
      "Funzzy on.socket is not configured in /project/.watch.yaml",
    );
  });
});
