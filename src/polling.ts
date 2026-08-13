import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { FunzzyConfig } from "./infra/config.js";
import type { Responder } from "./infra/ownership.js";
import type { WatcherExecutionState, WatcherStatus } from "./domain/watcher.js";
import type { WatcherStatusColor } from "./domain/status-presentation.js";
import type { createFailureNotifier } from "./domain/failure-notifier.js";

export interface PollingDeps {
  readConfig: (cwd: string) => Promise<FunzzyConfig | null>;
  createFailureNotifier: typeof createFailureNotifier;
  queryStatus: (socketPath: string) => Promise<WatcherStatus>;
  readResponder: (socketPath: string) => Promise<Responder | null>;
  recordsAgentActivity: (toolName: string) => boolean;
  recordAutomaticResponder: (socketPath: string, sessionId: string) => Promise<void>;
  renderWatcherFooter: (status: WatcherStatus) => string;
  watcherStatusColor: (state: WatcherExecutionState) => WatcherStatusColor;
  formatStatus: (status: WatcherStatus) => string;
}

export interface PollingLifecycle {
  sessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
  toolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<void>;
  agentSettled(): Promise<void>;
  sessionShutdown(ctx: ExtensionContext): Promise<void>;
}

const STATUS_KEY = "watcher-status";

export function createPollingLifecycle(pi: ExtensionAPI, deps: PollingDeps): PollingLifecycle {
  let pollTimer: NodeJS.Timeout | undefined;
  let pollStatus: (() => Promise<void>) | undefined;
  let activitySocketPath: string | undefined;
  let notifyFailure: ReturnType<typeof createFailureNotifier> | undefined;

  const setWatcherStatus = (
    ctx: ExtensionContext,
    text: string,
    color: WatcherStatusColor,
  ): void => {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text));
  };

  const resetSessionState = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    pollStatus = undefined;
    activitySocketPath = undefined;
    notifyFailure = undefined;
  };

  return {
    async sessionStart(_event, ctx) {
      resetSessionState();
      if (!ctx.isProjectTrusted()) return;
      const config = await deps.readConfig(ctx.cwd);
      if (!config || !ctx.hasUI) return;

      activitySocketPath = config.socketPath;
      notifyFailure = deps.createFailureNotifier(ctx.sessionManager.getSessionId(), (status) => {
        pi.sendMessage(
          {
            customType: "funzzy-failure",
            content: `Funzzy failed while this agent was idle. Investigate and fix the failure.\n${deps.formatStatus(status)}`,
            display: true,
            details: status,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      });

      let polling = false;
      const poll = async () => {
        if (polling) return;
        polling = true;
        try {
          const status = await deps.queryStatus(config.socketPath);
          setWatcherStatus(
            ctx,
            deps.renderWatcherFooter(status),
            deps.watcherStatusColor(status.state),
          );
          const responder = await deps.readResponder(config.socketPath);
          notifyFailure?.(status, ctx.isIdle(), responder?.sessionId ?? null);
        } catch {
          setWatcherStatus(ctx, "watcher: unavailable", "warning");
        } finally {
          polling = false;
        }
      };

      pollStatus = poll;
      await poll();
      pollTimer = setInterval(() => void poll(), config.pollIntervalMs);
    },

    async toolCall(event, ctx) {
      if (!activitySocketPath || !deps.recordsAgentActivity(event.toolName)) return;

      try {
        await deps.recordAutomaticResponder(activitySocketPath, ctx.sessionManager.getSessionId());
      } catch {
        // Activity attribution must never block the agent's tool call.
      }
    },

    async agentSettled() {
      await pollStatus?.();
    },

    async sessionShutdown(ctx) {
      resetSessionState();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    },
  };
}
