import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { FunzzyConfig } from "./infra/config.js";
import type { Responder } from "./infra/ownership.js";
import type { WatcherExecutionState, WatcherStatus } from "./domain/watcher.js";
import type { WatcherStatusColor } from "./domain/status-presentation.js";
import { observationFooterSuffix } from "./domain/observation.js";
import { firstFailedTask } from "./domain/failure-notifier.js";
import {
  normalizeEditPaths,
  recordEditCheckpoint,
  type EditCheckpoint,
} from "./domain/correlation.js";
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
  /** Record the session edit checkpoint (bounded, instance scoped). */
  recordEditCheckpoint: (sessionId: string, checkpoint: EditCheckpoint) => void;
  readEditCheckpoint: (sessionId: string) => EditCheckpoint | null;
  clearEditCheckpoint: (sessionId: string) => void;
  renderWatcherFooter: (status: WatcherStatus) => string;
  watcherStatusColor: (state: WatcherExecutionState) => WatcherStatusColor;
  formatStatus: (status: WatcherStatus) => string;
}

export interface PollingLifecycle {
  sessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
  /** Dispose lifecycle state and clear the status bar without starting anything. */
  reset(ctx: ExtensionContext): Promise<void>;
  toolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<void>;
  toolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<void>;
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
  let watcherInstanceToken: string | null = null;

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
    watcherInstanceToken = null;
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
            content: `Funzzy failed while this agent was idle. Investigate and fix the failure.\n${deps.formatStatus(status)}\nnext: watcher_output generation=${status.generation}${taskHint(status.failures)}`,
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
    let port: ObserverPort;
    try {
      const profile = await deps.loadCapabilities(config.socketPath);
      watcherInstanceToken = profile.instance.token;
      port =
        profile.features.subscription && profile.features.correlatedSnapshots
          ? deps.createSubscriptionPort(config.socketPath)
          : deps.createPollingPort(config.socketPath, config.pollIntervalMs);
    } catch {
      // A configured watcher may not be running when Pi starts. Keep the
      // extension loaded and let the polling port publish/recover availability.
      port = deps.createPollingPort(config.socketPath, config.pollIntervalMs);
    }

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
          // A checkpoint recorded under a previous watcher instance is stale:
          // clear it so correlation cannot cross instance boundaries.
          const checkpoint = deps.readEditCheckpoint(sessionId);
          const observedInstance = observation.snapshot?.instance.token ?? watcherInstanceToken;
          if (checkpoint !== null && checkpoint.instanceToken !== observedInstance) {
            deps.clearEditCheckpoint(sessionId);
          }
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
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);

    let config: FunzzyConfig | null;
    try {
      config = await deps.readConfig(ctx.cwd);
    } catch {
      // Keep the extension alive for malformed or unreadable project config.
      // Tool and command calls retain the detailed config error path.
      return;
    }
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

    async reset(ctx) {
      resetSessionState();
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    },

    async toolCall(event, ctx) {
      if (!activitySocketPath || !deps.recordsAgentActivity(event.toolName)) return;

      try {
        await deps.recordAutomaticResponder(activitySocketPath, ctx.sessionManager.getSessionId());
      } catch {
        // Activity attribution must never block the agent's tool call.
      }
    },

    async toolResult(event, ctx) {
      if (!activitySocketPath) return;
      // Only successful edit/write results create a checkpoint; unsupported
      // tools (e.g. bash) never have paths guessed from prose or output.
      const paths = editedPathsFromResult(event);
      if (paths.length === 0) return;

      const sessionId = ctx.sessionManager.getSessionId();
      const next = recordEditCheckpoint(
        deps.readEditCheckpoint(sessionId),
        normalizeEditPaths(paths, ctx.cwd),
        watcherInstanceToken,
        Date.now(),
      );
      if (next.paths.length > 0) deps.recordEditCheckpoint(sessionId, next);
    },

    async agentSettled() {
      // Push-driven: observations carry failures; no polling flush is needed.
    },

    async sessionShutdown(ctx) {
      await this.reset(ctx);
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

/**
 * Append the failed task name to the retrieval hint so the follow-up agent
 * can narrow watcher_output without guessing task names.
 */
function taskHint(failures: string[]): string {
  const task = firstFailedTask(failures);
  return task === null ? "" : ` task='${task}'`;
}

/**
 * Extract edited paths from a successful edit/write tool result. Unsupported
 * tools return nothing; paths are never guessed from prose or command output.
 */
function editedPathsFromResult(event: ToolResultEvent): string[] {
  if (event.isError) return [];
  if (event.toolName !== "edit" && event.toolName !== "write") return [];
  const path = event.input?.["path"];
  if (typeof path !== "string") return [];
  return [path];
}
