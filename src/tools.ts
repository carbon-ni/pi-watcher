import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WatcherStatus, WatcherTarget } from "./domain/watcher.js";
import type { RequireTrustedConfig } from "./trusted-config.js";
import type { StableRunOptions } from "./application/stable-run.js";
import type { Exec } from "./infra/fingerprint.js";

export interface ToolDeps {
  requireTrustedConfig: RequireTrustedConfig;
  queryStatus: (socketPath: string, timeoutMs?: number) => Promise<WatcherStatus>;
  waitForRun: (
    runId: number,
    timeoutMs: number,
    readStatus: () => Promise<WatcherStatus>,
    pollIntervalMs?: number,
    onUpdate?: (status: WatcherStatus) => void,
    updateIntervalMs?: number,
  ) => Promise<WatcherStatus>;
  formatStatus: (status: WatcherStatus) => string;
  listTargets: (socketPath: string, timeoutMs?: number) => Promise<WatcherTarget[]>;
  formatTargets: (targets: WatcherTarget[]) => string;
  requestRun: (socketPath: string, target: string) => Promise<number>;
  requestStableRun: (options: StableRunOptions) => Promise<WatcherStatus>;
  worktreeFingerprint: (cwd: string, exec: Exec) => Promise<string>;
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
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
      const config = await deps.requireTrustedConfig(ctx);

      let status = await deps.queryStatus(config.socketPath);
      if (params.wait && status.state === "running") {
        const startedAt = Date.now();
        status = await deps.waitForRun(
          status.generation,
          (params.timeoutSeconds ?? 120) * 1_000,
          async () => {
            if (signal?.aborted) throw new Error("Funzzy status wait was cancelled");
            return deps.queryStatus(config.socketPath);
          },
          Math.min(config.pollIntervalMs, 250),
          (update) => {
            const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000);
            onUpdate?.({
              content: [
                { type: "text", text: `${deps.formatStatus(update)} waited=${elapsedSeconds}s` },
              ],
              details: update,
            });
          },
          (params.updateIntervalSeconds ?? 5) * 1_000,
        );
      }

      return {
        content: [{ type: "text", text: deps.formatStatus(status) }],
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
      const config = await deps.requireTrustedConfig(ctx);

      const targets = await deps.listTargets(config.socketPath);
      return {
        content: [{ type: "text", text: deps.formatTargets(targets) }],
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
      const config = await deps.requireTrustedConfig(ctx);

      const fingerprint = () =>
        deps.worktreeFingerprint(ctx.cwd, (command, args, options) =>
          pi.exec(command, args, { ...options, signal }),
        );
      const before = await fingerprint();
      const target = params.target ?? "@agent-final";
      const timeoutMs = (params.timeoutSeconds ?? 120) * 1_000;
      const status = await deps.requestStableRun({
        timeoutMs,
        request: () => deps.requestRun(config.socketPath, target),
        readStatus: () => deps.queryStatus(config.socketPath),
        isWorktreeCurrent: async () => (await fingerprint()) === before,
        pollIntervalMs: Math.min(config.pollIntervalMs, 250),
      });
      const after = await fingerprint();

      if (before !== after) {
        throw new Error(
          `STALE gen=${status.generation}: worktree changed during Funzzy verification`,
        );
      }
      if (status.state !== "passed") throw new Error(deps.formatStatus(status));

      return {
        content: [
          { type: "text", text: `${deps.formatStatus(status)} fingerprint=${after.slice(0, 12)}` },
        ],
        details: { ...status, fingerprint: after },
      };
    },
  });
}
