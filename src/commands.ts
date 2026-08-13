import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WatcherStatus, WatcherTarget } from "./domain/watcher.js";
import type { Responder } from "./infra/ownership.js";
import { TrustedConfigError, type RequireTrustedConfig } from "./trusted-config.js";

export interface CommandDeps {
  requireTrustedConfig: RequireTrustedConfig;
  formatTargets: (targets: WatcherTarget[]) => string;
  formatStatus: (status: WatcherStatus) => string;
  listTargets: (socketPath: string, timeoutMs?: number) => Promise<WatcherTarget[]>;
  queryStatus: (socketPath: string, timeoutMs?: number) => Promise<WatcherStatus>;
  readResponder: (socketPath: string) => Promise<Responder | null>;
  setPinnedResponder: (socketPath: string, sessionId: string) => Promise<void>;
  clearPinnedResponder: (socketPath: string) => Promise<void>;
  recordAutomaticResponder: (socketPath: string, sessionId: string) => Promise<void>;
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("watcher-targets", {
    description: "List targets from the project's Funzzy control socket",
    handler: async (_args, ctx) => {
      try {
        const config = await deps.requireTrustedConfig(ctx);
        ctx.ui.notify(deps.formatTargets(await deps.listTargets(config.socketPath)), "info");
      } catch (error) {
        notifyCommandError(ctx, error);
      }
    },
  });

  pi.registerCommand("watcher-responder", {
    description: "Show, pin, or reset the Pi session that handles Funzzy failures",
    getArgumentCompletions: (prefix) => {
      const actions = ["status", "claim", "auto"];
      const matches = actions.filter((action) => action.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try {
        const config = await deps.requireTrustedConfig(ctx);

        const action = args.trim() || "status";
        const sessionId = ctx.sessionManager.getSessionId();
        if (action === "claim") {
          await deps.setPinnedResponder(config.socketPath, sessionId);
          ctx.ui.notify(`Funzzy responder pinned to this Pi session (${sessionId})`, "info");
          return;
        }
        if (action === "auto") {
          await deps.clearPinnedResponder(config.socketPath);
          await deps.recordAutomaticResponder(config.socketPath, sessionId);
          ctx.ui.notify("Funzzy responder returned to automatic activity tracking", "info");
          return;
        }
        if (action !== "status") {
          ctx.ui.notify("Usage: /watcher-responder [status|claim|auto]", "warning");
          return;
        }

        const responder = await deps.readResponder(config.socketPath);
        const message = responder
          ? `Funzzy responder: ${responder.mode} ${responder.sessionId}`
          : "Funzzy responder: none";
        ctx.ui.notify(message, "info");
      } catch (error) {
        notifyCommandError(ctx, error);
      }
    },
  });

  pi.registerCommand("watcher-status", {
    description: "Show status from the project's Funzzy control socket",
    handler: async (_args, ctx) => {
      try {
        const config = await deps.requireTrustedConfig(ctx);
        ctx.ui.notify(deps.formatStatus(await deps.queryStatus(config.socketPath)), "info");
      } catch (error) {
        notifyCommandError(ctx, error);
      }
    },
  });
}

function notifyCommandError(ctx: ExtensionCommandContext, error: unknown): void {
  if (error instanceof TrustedConfigError) {
    ctx.ui.notify(error.message, "warning");
    return;
  }
  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}
