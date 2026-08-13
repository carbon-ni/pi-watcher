import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { requestStableRun, waitForRun } from "./application/stable-run.js";
import { recordsAgentActivity } from "./domain/activity.js";
import { createFailureNotifier } from "./domain/failure-notifier.js";
import { renderWatcherFooter, watcherStatusColor } from "./domain/status-presentation.js";
import { formatTargets } from "./domain/targets-presentation.js";
import { formatStatus, listTargets, queryStatus, requestRun } from "./infra/client.js";
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

  const lifecycle = createPollingLifecycle(pi, {
    readConfig,
    createFailureNotifier,
    queryStatus,
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
    requestRun,
    requestStableRun,
    worktreeFingerprint,
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
