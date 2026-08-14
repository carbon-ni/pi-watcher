import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { waitForRun } from "./application/stable-run.js";
import { requestVerifiedRun } from "./application/verify.js";
import { requestObservation } from "./application/observe.js";
import { requestCancellation } from "./application/cancel.js";
import { recordsAgentActivity } from "./domain/activity.js";
import { createFailureNotifier } from "./domain/failure-notifier.js";
import { renderWatcherFooter, watcherStatusColor } from "./domain/status-presentation.js";
import { formatTargets } from "./domain/targets-presentation.js";
import { WatcherOutputUnavailableError } from "./domain/output.js";
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
import { createAtomicVerifyPort, createLegacyVerifyPort } from "./infra/verify.js";
import { readConfig } from "./infra/config.js";
import { worktreeFingerprint } from "./infra/fingerprint.js";
import {
  clearPinnedResponder,
  readResponder,
  recordAutomaticResponder,
  setPinnedResponder,
} from "./infra/ownership.js";
import { connectSession, disconnectSession, isSessionDisconnected } from "./infra/membership.js";
import { createPollingLifecycle } from "./polling.js";
import { registerTools } from "./tools.js";
import { registerCommands } from "./commands.js";
import { createRequireTrustedConfig } from "./trusted-config.js";

export default function funzzyStatus(pi: ExtensionAPI) {
  const requireTrustedConfig = createRequireTrustedConfig(readConfig);
  const capabilityCache = new CapabilityCache();

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
    renderWatcherFooter,
    watcherStatusColor,
    formatStatus,
  });

  pi.on("session_start", (event, ctx) => lifecycle.sessionStart(event, ctx));
  pi.on("tool_call", (event, ctx) => lifecycle.toolCall(event, ctx));
  pi.on("agent_settled", () => lifecycle.agentSettled());
  pi.on("session_shutdown", (_event, ctx) => lifecycle.sessionShutdown(ctx));

  registerTools(pi, {
    requireTrustedConfig,
    queryStatus,
    waitForRun,
    formatStatus,
    listTargets,
    formatTargets,
    verifyRequest: async (config, request, fingerprint, signal) => {
      const profile = await loadCapabilities(config.socketPath, capabilityCache);
      const port =
        profile.features.atomicAwait && profile.features.correlatedSnapshots
          ? createAtomicVerifyPort(config.socketPath, profile.instance.token)
          : createLegacyVerifyPort({
              socketPath: config.socketPath,
              pollIntervalMs: Math.min(config.pollIntervalMs, 250),
              requestRun,
              queryStatus,
            });
      return requestVerifiedRun(request, { port, fingerprint, signal });
    },
    worktreeFingerprint,
    createObservePort: async (config) => {
      const profile = await loadCapabilities(config.socketPath, capabilityCache);
      return profile.features.subscription && profile.features.correlatedSnapshots
        ? createSubscriptionPort(config.socketPath)
        : createPollingPort(queryStatus, config.socketPath, Math.min(config.pollIntervalMs, 250));
    },
    classifyObservationError,
    requestObservation,
    requestOutput: async (socketPath, request, signal) => {
      const profile = await loadCapabilities(socketPath, capabilityCache);
      if (!profile.features.outputRetrieval) {
        throw new WatcherOutputUnavailableError();
      }
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
  });

  registerCommands(pi, {
    requireTrustedConfig,
    formatTargets,
    formatStatus,
    listTargets,
    queryStatus,
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
