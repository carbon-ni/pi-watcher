import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatStatus,
  listTargets,
  queryStatus,
  requestRun,
  type FunzzyTarget,
} from "./infra/client.js";
import { requestStableRun, waitForRun } from "./application/stable-run.js";
import { readConfig } from "./infra/config.js";
import { worktreeFingerprint } from "./infra/fingerprint.js";
import { createFailureNotifier } from "./domain/failure-notifier.js";
import { recordsAgentActivity } from "./domain/activity.js";
import { renderWatcherFooter, watcherStatusColor } from "./domain/status-presentation.js";
import {
  clearPinnedResponder,
  readResponder,
  recordAutomaticResponder,
  setPinnedResponder,
} from "./infra/ownership.js";

const STATUS_KEY = "watcher-status";

export default function funzzyStatus(pi: ExtensionAPI) {
  let pollTimer: NodeJS.Timeout | undefined;
  let pollStatus: (() => Promise<void>) | undefined;
  let activitySocketPath: string | undefined;
  let notifyFailure: ReturnType<typeof createFailureNotifier> | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    const config = await readConfig(ctx.cwd);
    if (!config || !ctx.hasUI) return;

    activitySocketPath = config.socketPath;
    notifyFailure = createFailureNotifier(ctx.sessionManager.getSessionId(), (status) => {
      pi.sendMessage(
        {
          customType: "funzzy-failure",
          content: `Funzzy failed while this agent was idle. Investigate and fix the failure.\n${formatStatus(status)}`,
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
        const status = await queryStatus(config.socketPath);
        ctx.ui.setStatus(
          STATUS_KEY,
          ctx.ui.theme.fg(watcherStatusColor(status.state), renderWatcherFooter(status)),
        );
        const responder = await readResponder(config.socketPath);
        notifyFailure?.(status, ctx.isIdle(), responder?.sessionId ?? null);
      } catch {
        ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "watcher: unavailable"));
      } finally {
        polling = false;
      }
    };

    pollStatus = poll;
    await poll();
    pollTimer = setInterval(() => void poll(), config.pollIntervalMs);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!activitySocketPath || !recordsAgentActivity(event.toolName)) return;

    try {
      await recordAutomaticResponder(activitySocketPath, ctx.sessionManager.getSessionId());
    } catch {
      // Activity attribution must never block the agent's tool call.
    }
  });

  pi.on("agent_settled", async () => {
    await pollStatus?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    pollStatus = undefined;
    activitySocketPath = undefined;
    notifyFailure = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerTool({
    name: "watcher_status",
    label: "Watcher Status",
    description: "Read or await compact test status from the project's external Funzzy watcher",
    promptSnippet: "Check the external Funzzy watcher without rerunning tests",
    promptGuidelines: [
      "Call watcher_status before finishing work when .watch.yaml configures on.socket; use wait=true when a run is active instead of rerunning tests through bash.",
    ],
    parameters: Type.Object({
      wait: Type.Optional(
        Type.Boolean({ description: "Wait for the currently running generation" }),
      ),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900 })),
      updateIntervalSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.isProjectTrusted()) throw new Error("Funzzy project configuration is not trusted");
      const config = await readConfig(ctx.cwd);
      if (!config) throw new Error(`Funzzy on.socket is not configured in ${ctx.cwd}/.watch.yaml`);

      let status = await queryStatus(config.socketPath);
      if (params.wait && status.state === "running") {
        const startedAt = Date.now();
        status = await waitForRun(
          status.generation,
          (params.timeoutSeconds ?? 120) * 1_000,
          async () => {
            if (signal?.aborted) throw new Error("Funzzy status wait was cancelled");
            return queryStatus(config.socketPath);
          },
          Math.min(config.pollIntervalMs, 250),
          (update) => {
            const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000);
            onUpdate?.({
              content: [
                { type: "text", text: `${formatStatus(update)} waited=${elapsedSeconds}s` },
              ],
              details: update,
            });
          },
          (params.updateIntervalSeconds ?? 5) * 1_000,
        );
      }

      return {
        content: [{ type: "text", text: formatStatus(status) }],
        details: status,
      };
    },
  });

  pi.registerTool({
    name: "watcher_targets",
    label: "Watcher Targets",
    description: "List configured Funzzy targets and their commands from the external watcher",
    promptSnippet: "Discover available Funzzy targets before requesting a run",
    promptGuidelines: [
      "Call watcher_targets when choosing a verification target instead of guessing its name.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!ctx.isProjectTrusted()) throw new Error("Funzzy project configuration is not trusted");
      const config = await readConfig(ctx.cwd);
      if (!config) throw new Error(`Funzzy on.socket is not configured in ${ctx.cwd}/.watch.yaml`);

      const targets = await listTargets(config.socketPath);
      return {
        content: [{ type: "text", text: formatTargets(targets) }],
        details: { targets },
      };
    },
  });

  pi.registerTool({
    name: "watcher_verify",
    label: "Watcher Verify",
    description:
      "Run a named Funzzy target externally and return only its compact final result; use watcher_targets to discover names",
    promptSnippet: "Run the external Funzzy final verification gate",
    promptGuidelines: [
      "Use watcher_verify for final verification when .watch.yaml configures on.socket; accept a pass only when its worktree fingerprint remains unchanged.",
    ],
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Funzzy task-name substring" })),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.isProjectTrusted()) throw new Error("Funzzy project configuration is not trusted");
      const config = await readConfig(ctx.cwd);
      if (!config) throw new Error(`Funzzy on.socket is not configured in ${ctx.cwd}/.watch.yaml`);

      const fingerprint = () =>
        worktreeFingerprint(ctx.cwd, (command, args, options) =>
          pi.exec(command, args, { ...options, signal }),
        );
      const before = await fingerprint();
      const target = params.target ?? "@agent-final";
      const timeoutMs = (params.timeoutSeconds ?? 120) * 1_000;
      const status = await requestStableRun({
        timeoutMs,
        request: () => requestRun(config.socketPath, target),
        readStatus: () => queryStatus(config.socketPath),
        isWorktreeCurrent: async () => (await fingerprint()) === before,
        pollIntervalMs: Math.min(config.pollIntervalMs, 250),
      });
      const after = await fingerprint();

      if (before !== after) {
        throw new Error(
          `STALE gen=${status.generation}: worktree changed during Funzzy verification`,
        );
      }
      if (status.state !== "passed") throw new Error(formatStatus(status));

      return {
        content: [
          { type: "text", text: `${formatStatus(status)} fingerprint=${after.slice(0, 12)}` },
        ],
        details: { ...status, fingerprint: after },
      };
    },
  });

  pi.registerCommand("watcher-targets", {
    description: "List targets from the project's Funzzy control socket",
    handler: async (_args, ctx) => {
      try {
        if (!ctx.isProjectTrusted()) {
          ctx.ui.notify("Funzzy project configuration is not trusted", "warning");
          return;
        }
        const config = await readConfig(ctx.cwd);
        if (!config) {
          ctx.ui.notify(`Funzzy on.socket is not configured in ${ctx.cwd}/.watch.yaml`, "warning");
          return;
        }
        ctx.ui.notify(formatTargets(await listTargets(config.socketPath)), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
        if (!ctx.isProjectTrusted()) {
          ctx.ui.notify("Funzzy project configuration is not trusted", "warning");
          return;
        }
        const config = await readConfig(ctx.cwd);
        if (!config) {
          ctx.ui.notify(`Funzzy on.socket is not configured in ${ctx.cwd}/.watch.yaml`, "warning");
          return;
        }

        const action = args.trim() || "status";
        const sessionId = ctx.sessionManager.getSessionId();
        if (action === "claim") {
          await setPinnedResponder(config.socketPath, sessionId);
          ctx.ui.notify(`Funzzy responder pinned to this Pi session (${sessionId})`, "info");
          return;
        }
        if (action === "auto") {
          await clearPinnedResponder(config.socketPath);
          await recordAutomaticResponder(config.socketPath, sessionId);
          ctx.ui.notify("Funzzy responder returned to automatic activity tracking", "info");
          return;
        }
        if (action !== "status") {
          ctx.ui.notify("Usage: /watcher-responder [status|claim|auto]", "warning");
          return;
        }

        const responder = await readResponder(config.socketPath);
        const message = responder
          ? `Funzzy responder: ${responder.mode} ${responder.sessionId}`
          : "Funzzy responder: none";
        ctx.ui.notify(message, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("watcher-status", {
    description: "Show status from the project's Funzzy control socket",
    handler: async (_args, ctx) => {
      try {
        if (!ctx.isProjectTrusted()) {
          ctx.ui.notify("Funzzy project configuration is not trusted", "warning");
          return;
        }
        const config = await readConfig(ctx.cwd);
        if (!config) {
          ctx.ui.notify(`Funzzy on.socket is not configured in ${ctx.cwd}/.watch.yaml`, "warning");
          return;
        }
        ctx.ui.notify(formatStatus(await queryStatus(config.socketPath)), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

function formatTargets(targets: FunzzyTarget[]): string {
  if (targets.length === 0) return "No Funzzy targets configured";
  return targets.map((target) => `- ${target.name}: ${target.commands.join(" && ")}`).join("\n");
}
