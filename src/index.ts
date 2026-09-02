import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { waitForRun } from "./application/stable-run.js";
import { requestVerifiedRun } from "./application/verify.js";
import { requestObservation } from "./application/observe.js";
import { requestCancellation } from "./application/cancel.js";
import { recordsAgentActivity } from "./domain/activity.js";
import { createFailureNotifier } from "./domain/failure-notifier.js";
import { renderWatcherFooter, watcherStatusColor } from "./domain/status-presentation.js";
import { formatTargets } from "./domain/targets-presentation.js";
import { selectVerificationTimeout } from "./domain/timeout-selection.js";
import { WatcherOutputUnavailableError } from "./domain/output.js";
import { ensureOutputReferenceCompatibility } from "./domain/output-reference.js";
import type { EditCheckpoint } from "./domain/correlation.js";
import {
  formatStatus,
  listTargets,
  queryStatus,
  requestOutput as requestOutputClient,
  requestRun,
} from "./infra/client.js";
import { CapabilityCache, loadCapabilities } from "./infra/capabilities.js";
import { createPollingPort, createSubscriptionPort } from "./infra/observer.js";
import { classifyObservationError } from "./infra/observe.js";
import { createCancelPort } from "./infra/cancel.js";
import { claimFailureDelivery } from "./infra/delivery.js";
import { createAtomicVerifyPort, createLegacyVerifyPort } from "./infra/verify.js";
import { readConfig, readConfigPresence } from "./infra/config.js";
import { worktreeFingerprint } from "./infra/fingerprint.js";
import {
  clearPinnedResponder,
  readResponder,
  recordAutomaticResponder,
  setPinnedResponder,
} from "./infra/ownership.js";
import { connectSession, disconnectSession, isSessionDisconnected } from "./infra/membership.js";
import { createPollingLifecycle } from "./polling.js";
import { registerTools, type ToolDeps } from "./tools.js";
import { registerCommands } from "./commands.js";
import { createWatcherRegistration } from "./registration.js";
import { createRequireTrustedConfig } from "./trusted-config.js";

export default function funzzyStatus(pi: ExtensionAPI) {
  const requireTrustedConfig = createRequireTrustedConfig(readConfig);
  const capabilityCache = new CapabilityCache();

  // Bounded per-session registry of failure engagements recorded by the tools,
  // so a follow-up never interrupts a session that already saw the failure
  // through watcher_observe or watcher_verify (contract §8).
  const HANDLED_FAILURE_TTL_MS = 10 * 60_000;
  const HANDLED_FAILURE_MAX = 20;
  const handledFailures = new Map<string, Array<{ key: string; at: number }>>();
  const recordHandledFailure = (sessionId: string, key: string): void => {
    const now = Date.now();
    const entries = (handledFailures.get(sessionId) ?? []).filter(
      (entry) => now - entry.at < HANDLED_FAILURE_TTL_MS,
    );
    entries.push({ key, at: now });
    if (entries.length > HANDLED_FAILURE_MAX) {
      entries.splice(0, entries.length - HANDLED_FAILURE_MAX);
    }
    handledFailures.set(sessionId, entries);
  };
  const isHandledFailure = (sessionId: string, key: string): boolean => {
    const now = Date.now();
    return (handledFailures.get(sessionId) ?? []).some(
      (entry) => entry.key === key && now - entry.at < HANDLED_FAILURE_TTL_MS,
    );
  };

  // Session edit checkpoints for batch correlation (contract §9): bounded,
  // per-session, cleared on watcher instance change by the lifecycle.
  const editCheckpoints = new Map<string, EditCheckpoint>();
  const recordEditCheckpoint = (sessionId: string, checkpoint: EditCheckpoint): void => {
    editCheckpoints.set(sessionId, checkpoint);
  };
  const readEditCheckpoint = (sessionId: string): EditCheckpoint | null =>
    editCheckpoints.get(sessionId) ?? null;
  const clearEditCheckpoint = (sessionId: string): void => {
    editCheckpoints.delete(sessionId);
  };

  const lifecycle = createPollingLifecycle(pi, {
    readConfig,
    createFailureNotifier,
    loadCapabilities: (socketPath) => loadCapabilities(socketPath, capabilityCache),
    invalidateCapabilities: () => capabilityCache.invalidate(),
    createSubscriptionPort,
    createPollingPort: (socketPath, pollIntervalMs) =>
      createPollingPort(queryStatus, socketPath, pollIntervalMs),
    readResponder,
    recordsAgentActivity,
    recordAutomaticResponder,
    isSessionDisconnected,
    isHandledFailure,
    claimFailureDelivery,
    recordEditCheckpoint,
    readEditCheckpoint,
    clearEditCheckpoint,
    renderWatcherFooter,
    watcherStatusColor,
    formatStatus,
  });

  const registration = createWatcherRegistration(pi, {
    readConfigPresence,
    registerWatcherTools: () => registerTools(pi, toolDeps),
    startWatcherSession: (event, ctx) => lifecycle.sessionStart(event, ctx),
    resetWatcherSession: (ctx) => lifecycle.reset(ctx),
  });

  pi.on("session_start", (event, ctx) => registration.sessionStart(event, ctx));
  pi.on("tool_call", (event, ctx) => lifecycle.toolCall(event, ctx));
  pi.on("tool_result", (event, ctx) => lifecycle.toolResult(event, ctx));
  pi.on("agent_settled", () => lifecycle.agentSettled());
  pi.on("session_shutdown", (_event, ctx) => lifecycle.sessionShutdown(ctx));

  const toolDeps: ToolDeps = {
    requireTrustedConfig,
    queryStatus,
    waitForRun,
    formatStatus,
    listTargets,
    formatTargets,
    selectVerifyTimeout: async (config, target, explicitTimeoutMs, sequential) => {
      const profile = await loadCapabilities(config.socketPath, capabilityCache);
      return selectVerificationTimeout({
        explicitTimeoutMs,
        durationEstimatesSupported: profile.features.durationEstimates,
        estimate: target.estimate,
        sequential,
      });
    },
    verifyRequest: async (config, request, fingerprint, signal, onGeneration, onProgress) => {
      const profile = await loadCapabilities(config.socketPath, capabilityCache);
      if (request.sequential && !profile.features.sequentialOverride) {
        throw new Error(
          `Funzzy watcher does not support sequential verification; run fzz run ${request.target} --sequential locally`,
        );
      }
      const port =
        profile.features.atomicAwait && profile.features.correlatedSnapshots
          ? createAtomicVerifyPort(config.socketPath, profile.instance.token, profile.schemaVersion)
          : createLegacyVerifyPort({
              socketPath: config.socketPath,
              pollIntervalMs: Math.min(config.pollIntervalMs, 250),
              requestRun,
              queryStatus,
            });
      return requestVerifiedRun(request, { port, fingerprint, signal, onGeneration, onProgress });
    },
    worktreeFingerprint,
    createObservePort: async (config) => {
      const profile = await loadCapabilities(config.socketPath, capabilityCache);
      return profile.features.subscription && profile.features.correlatedSnapshots
        ? createSubscriptionPort(config.socketPath, profile.schemaVersion)
        : createPollingPort(queryStatus, config.socketPath, Math.min(config.pollIntervalMs, 250));
    },
    classifyObservationError,
    requestObservation,
    recordHandledFailure,
    readEditCheckpoint,
    requestOutput: async (socketPath, request, signal) => {
      const profile = await loadCapabilities(socketPath, capabilityCache);
      if (!profile.features.outputRetrieval) {
        throw new WatcherOutputUnavailableError();
      }
      ensureOutputReferenceCompatibility(profile.limits);
      return requestOutputClient(socketPath, request, 10_000, signal);
    },
    cancelGeneration: async (config, generation, timeoutMs) => {
      const profile = await loadCapabilities(config.socketPath, capabilityCache);
      return requestCancellation(
        { generation, timeoutMs },
        {
          port: createCancelPort({
            socketPath: config.socketPath,
            instanceToken: profile.instance.token,
          }),
        },
      );
    },
  };

  registerCommands(pi, {
    requireTrustedConfig,
    formatTargets,
    formatStatus,
    listTargets,
    queryStatus,
    requestRun,
    readResponder,
    setPinnedResponder,
    clearPinnedResponder,
    recordAutomaticResponder,
    disconnectSession,
    connectSession,
    disconnectWatcher: (ctx) => lifecycle.disconnect(ctx),
    connectWatcher: (ctx) => lifecycle.connect(ctx),
  });
}
