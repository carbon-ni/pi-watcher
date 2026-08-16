import type { FunzzyConfig } from "./infra/config.js";

export type ReadConfig = (cwd: string) => Promise<FunzzyConfig | null>;

export interface TrustedContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

export class TrustedConfigError extends Error {
  readonly kind: "untrusted" | "not-configured";

  constructor(kind: "untrusted" | "not-configured", message: string) {
    super(message);
    this.name = "TrustedConfigError";
    this.kind = kind;
  }
}

export function createRequireTrustedConfig(readConfig: ReadConfig) {
  return async function requireTrustedConfig(ctx: TrustedContext): Promise<FunzzyConfig> {
    if (!ctx.isProjectTrusted()) {
      throw new TrustedConfigError("untrusted", "Funzzy project configuration is not trusted");
    }
    const config = await readConfig(ctx.cwd);
    if (!config) {
      throw new TrustedConfigError(
        "not-configured",
        `Funzzy on.socket is not configured in ${ctx.cwd}/.watch.yaml`,
      );
    }
    return config;
  };
}

export type RequireTrustedConfig = ReturnType<typeof createRequireTrustedConfig>;
