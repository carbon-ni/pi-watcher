import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SupersededRunError, waitForRun } from "./application/stable-run.js";
import type { WatcherStatus, WatcherTarget } from "./domain/watcher.js";
import type { Responder } from "./infra/ownership.js";
import { TrustedConfigError, type RequireTrustedConfig } from "./trusted-config.js";

export interface CommandDeps {
  requireTrustedConfig: RequireTrustedConfig;
  formatTargets: (targets: WatcherTarget[]) => string;
  formatStatus: (status: WatcherStatus) => string;
  listTargets: (socketPath: string, timeoutMs?: number) => Promise<WatcherTarget[]>;
  queryStatus: (socketPath: string, timeoutMs?: number) => Promise<WatcherStatus>;
  requestRun: (socketPath: string, target: string, timeoutMs?: number) => Promise<number>;
  readResponder: (socketPath: string) => Promise<Responder | null>;
  setPinnedResponder: (socketPath: string, sessionId: string) => Promise<void>;
  clearPinnedResponder: (socketPath: string) => Promise<void>;
  recordAutomaticResponder: (socketPath: string, sessionId: string) => Promise<void>;
  disconnectSession: (socketPath: string, sessionId: string) => Promise<void>;
  connectSession: (socketPath: string, sessionId: string) => Promise<void>;
  disconnectWatcher: (ctx: ExtensionCommandContext) => Promise<void>;
  connectWatcher: (ctx: ExtensionCommandContext) => Promise<void>;
}

export const DEFAULT_FINAL_GATE_SHORTCUT = "ctrl+shift+alt+f" as const;
const SHORTCUT_WAIT_TIMEOUT_MS = 120_000;

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  let shortcutPending = false;
  let triggeredGeneration: number | null = null;
  pi.registerShortcut(DEFAULT_FINAL_GATE_SHORTCUT, {
    description: "Run the default Funzzy @agent-final gate when the watcher is idle",
    handler: async (ctx) => {
      if (shortcutPending) {
        ctx.ui.notify("Funzzy final gate shortcut is already pending; ignoring duplicate", "info");
        return;
      }
      shortcutPending = true;
      try {
        const config = await deps.requireTrustedConfig(ctx);
        let status = await deps.queryStatus(config.socketPath);
        if (triggeredGeneration !== null) {
          if (status.generation >= triggeredGeneration && status.state === "running") {
            ctx.ui.notify(
              `Funzzy final gate is already pending or running (generation ${triggeredGeneration})`,
              "info",
            );
            return;
          }
          // A lower generation identifies a watcher restart. Do not let the
          // previous process's generation suppress future shortcut presses.
          triggeredGeneration = null;
        }
        if (status.state === "running") {
          ctx.ui.notify(
            `Funzzy final gate accepted; waiting for generation ${status.generation} to finish`,
            "info",
          );
          while (status.state === "running") {
            try {
              status = await waitForRun(
                status.generation,
                SHORTCUT_WAIT_TIMEOUT_MS,
                () => deps.queryStatus(config.socketPath),
                Math.min(config.pollIntervalMs, 250),
              );
            } catch (error) {
              if (!(error instanceof SupersededRunError)) throw error;
              status = await deps.queryStatus(config.socketPath);
            }
          }
        }
        const generation = await deps.requestRun(config.socketPath, "@agent-final");
        triggeredGeneration = generation;
        ctx.ui.notify(`Funzzy final gate started: @agent-final generation ${generation}`, "info");
      } catch (error) {
        notifyCommandError(ctx, error);
      } finally {
        shortcutPending = false;
      }
    },
  });

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

  pi.registerCommand("watcher-disconnect", {
    description:
      "Disconnect this Pi session from the Funzzy watcher so it stops receiving watcher messages",
    handler: async (_args, ctx) => {
      try {
        const config = await deps.requireTrustedConfig(ctx);
        const sessionId = ctx.sessionManager.getSessionId();

        await deps.disconnectSession(config.socketPath, sessionId);
        const responder = await deps.readResponder(config.socketPath);
        if (responder?.mode === "pinned" && responder.sessionId === sessionId) {
          await deps.clearPinnedResponder(config.socketPath);
        }
        await deps.disconnectWatcher(ctx);
        ctx.ui.notify("Watcher disconnected for this session", "info");
      } catch (error) {
        notifyCommandError(ctx, error);
      }
    },
  });

  pi.registerCommand("watcher-connect", {
    description: "Reconnect this Pi session to the Funzzy watcher",
    handler: async (_args, ctx) => {
      try {
        const config = await deps.requireTrustedConfig(ctx);
        const sessionId = ctx.sessionManager.getSessionId();

        await deps.connectSession(config.socketPath, sessionId);
        await deps.connectWatcher(ctx);
        ctx.ui.notify("Watcher reconnected for this session", "info");
      } catch (error) {
        notifyCommandError(ctx, error);
      }
    },
  });
}

type NotifyContext = {
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
};

function notifyCommandError(ctx: NotifyContext, error: unknown): void {
  if (error instanceof TrustedConfigError) {
    ctx.ui.notify(error.message, "warning");
    return;
  }
  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}
