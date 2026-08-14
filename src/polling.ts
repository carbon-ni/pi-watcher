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
import { observationFooterSuffix } from "./domain/observation.js";
import type { WatcherCapabilityProfile } from "./domain/capabilities.js";
import { createObserver, type ObserverPort } from "./application/observer.js";
import type { createFailureNotifier } from "./domain/failure-notifier.js";

export interface PollingDeps {
  readConfig: (cwd: string) => Promise<FunzzyConfig | null>;
  createFailureNotifier: typeof createFailureNotifier;
  loadCapabilities: (socketPath: string) => Promise<WatcherCapabilityProfile>;
  invalidateCapabilities: () => void;
  createSubscriptionPort: (socketPath: string) => ObserverPort;
  createPollingPort: (socketPath: string, pollIntervalMs: number) => ObserverPort;
  readResponder: (socketPath: string) => Promise<Responder | null>;
  recordsAgentActivity: (toolName: string) => boolean;
  recordAutomaticResponder: (socketPath: string, sessionId: string) => Promise<void>;
  isSessionDisconnected: (socketPath: string, sessionId: string) => Promise<boolean>;
  /** Whether this session already observed/verified the failure key. */
  isHandledFailure: (sessionId: string, key: string) => boolean;
  /** Atomic cross-session at-most-once delivery claim. */
  claimFailureDelivery: (socketPath: string, key: string) => Promise<boolean>;
  renderWatcherFooter: (status: WatcherStatus) => string;
  watcherStatusColor: (state: WatcherExecutionState) => WatcherStatusColor;
  formatStatus: (status: WatcherStatus) => string;
}

export interface PollingLifecycle {
  sessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
  toolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<void>;
  agentSettled(): Promise<void>;
  sessionShutdown(ctx: ExtensionContext): Promise<void>;
  disconnect(ctx: ExtensionContext): Promise<void>;
  connect(ctx: ExtensionContext): Promise<void>;
}

const STATUS_KEY = "watcher-status";

export function createPollingLifecycle(pi: ExtensionAPI, deps: PollingDeps): PollingLifecycle {
  let observer: ReturnType<typeof createObserver> | undefined;
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
    observer?.dispose();
    observer = undefined;
    activitySocketPath = undefined;
    notifyFailure = undefined;
  };

  const startWatching = async (config: FunzzyConfig, ctx: ExtensionContext): Promise<void> => {
    activitySocketPath = config.socketPath;
    const sessionId = ctx.sessionManager.getSessionId();
    notifyFailure = deps.createFailureNotifier(
      sessionId,
      (status) => {
        pi.sendMessage(
          {
            customType: "funzzy-failure",
            content: `Funzzy failed while this agent was idle. Investigate and fix the failure.\n${deps.formatStatus(status)}\nnext: watcher_output generation=${status.generation}`,
            display: true,
            details: status,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
      {
        isHandled: (key) => deps.isHandledFailure(sessionId, key),
        claimDelivery: (key) => deps.claimFailureDelivery(config.socketPath, key),
      },
    );

    // Capability-gated transport (contract §8): subscription when the watcher
    // supports it, legacy polling otherwise. Polled observations are marked
    // with the weaker-freshness footer suffix by the sink below.
    const profile = await deps.loadCapabilities(config.socketPath);
    const port =
      profile.features.subscription && profile.features.correlatedSnapshots
        ? deps.createSubscriptionPort(config.socketPath)
        : deps.createPollingPort(config.socketPath, config.pollIntervalMs);

    const current = createObserver({
      port,
      sink: {
        onObservation: (observation) => {
          if (observer !== current) return; // session reset or disconnected mid-flight
          setWatcherStatus(
            ctx,
            deps.renderWatcherFooter(observation.status) +
              observationFooterSuffix(observation.source),
            deps.watcherStatusColor(observation.status.state),
          );
          void deps.readResponder(config.socketPath).then((responder) => {
            if (observer !== current) return;
            void notifyFailure?.(observation, ctx.isIdle(), responder?.sessionId ?? null);
          });
        },
        onUnavailable: () => {
          if (observer !== current) return;
          setWatcherStatus(ctx, "watcher: unavailable", "warning");
        },
      },
    });
    observer = current;
    await current.start();
  };

  const beginSession = async (ctx: ExtensionContext): Promise<void> => {
    resetSessionState();
    if (!ctx.isProjectTrusted()) return;
    const config = await deps.readConfig(ctx.cwd);
    if (!config || !ctx.hasUI) return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (await deps.isSessionDisconnected(config.socketPath, sessionId)) {
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "watcher: disconnected"));
      return;
    }

    await startWatching(config, ctx);
  };

  return {
    async sessionStart(_event, ctx) {
      await beginSession(ctx);
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
      // Push-driven: observations carry failures; no polling flush is needed.
    },

    async sessionShutdown(ctx) {
      resetSessionState();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    },

    async disconnect(ctx) {
      if (activitySocketPath === undefined) return;
      resetSessionState();
      // The watcher instance may have changed; re-negotiate on next connect.
      deps.invalidateCapabilities();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    },

    async connect(ctx) {
      await beginSession(ctx);
    },
  };
}
