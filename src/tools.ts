import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WatcherStatus, WatcherTarget } from "./domain/watcher.js";
import type { WatcherVerification, WatcherVerifyRequest } from "./domain/verification.js";
import { formatVerification, selectTarget } from "./domain/verification.js";
import {
  formatObservation,
  formatObservationProgress,
  type WatcherObserveRequest,
  type WatcherObservationResult,
} from "./domain/observation-result.js";
import {
  formatWatcherOutput,
  type WatcherOutputRequest,
  type WatcherOutputResult,
} from "./domain/output.js";
import {
  formatCancellation,
  cancellationReport,
  type WatcherCancelResult,
} from "./domain/cancel.js";
import { failureEngagementKeyParts } from "./domain/failure-notifier.js";
import type { EditCheckpoint } from "./domain/correlation.js";
import type { RequireTrustedConfig } from "./trusted-config.js";
import type { Exec } from "./infra/fingerprint.js";
import type { FunzzyConfig } from "./infra/config.js";
import type { ObserverPort } from "./application/observer.js";
import type { ObserveDeps } from "./application/observe.js";

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
  verifyRequest: (
    config: FunzzyConfig,
    request: WatcherVerifyRequest,
    fingerprint: () => Promise<string>,
    signal?: AbortSignal,
    onGeneration?: (generation: number) => void,
  ) => Promise<WatcherVerification>;
  worktreeFingerprint: (cwd: string, exec: Exec) => Promise<string>;
  createObservePort: (config: FunzzyConfig) => Promise<ObserverPort>;
  classifyObservationError: (error: unknown) => "disconnect" | "unknown";
  requestObservation: (
    request: WatcherObserveRequest,
    deps: ObserveDeps,
  ) => Promise<WatcherObservationResult>;
  requestOutput: (
    socketPath: string,
    request: WatcherOutputRequest,
    signal?: AbortSignal,
  ) => Promise<WatcherOutputResult>;
  /** Compare-and-cancel an exact generation with a bounded acknowledgement wait. */
  cancelGeneration: (
    config: FunzzyConfig,
    generation: number,
    timeoutMs: number,
  ) => Promise<WatcherCancelResult>;
  /** Record that this session already saw a failed generation (no follow-up). */
  recordHandledFailure: (sessionId: string, key: string) => void;
  /** Session edit checkpoint used to classify batch correlation. */
  readEditCheckpoint: (sessionId: string) => EditCheckpoint | null;
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
    name: "watcher_observe",
    label: "Watcher Observe",
    description:
      "Snapshot or atomically await the external Funzzy watcher state without triggering work",
    promptSnippet: "Observe the external Funzzy watcher without rerunning tests",
    promptGuidelines: [
      "Call watcher_observe to snapshot watcher state or await the terminal result of a generation; it never triggers or cancels work.",
      "Pass afterGeneration (a previously observed generation) with wait=true to await the first newer generation, e.g. after an edit.",
    ],
    parameters: Type.Object({
      afterGeneration: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Wait for the first generation newer than this one (used with wait)",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description: "Wait for a terminal state or a generation after afterGeneration",
        }),
      ),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900 })),
      updateIntervalSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
      maxEvidenceLines: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 40,
          description: "Max failure evidence lines to include (0 = none; default 40)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = await deps.requireTrustedConfig(ctx);
      const port = await deps.createObservePort(config);
      const wait = params.wait ?? false;
      const startedAt = Date.now();
      let lastUpdateAt = 0;
      let lastKey = "";

      const result = await deps.requestObservation(
        {
          wait,
          afterGeneration: params.afterGeneration ?? null,
          timeoutMs: (params.timeoutSeconds ?? (wait ? 120 : 10)) * 1_000,
          maxEvidenceLines: params.maxEvidenceLines,
        },
        {
          port,
          signal,
          classifyError: deps.classifyObservationError,
          checkpoint: deps.readEditCheckpoint(ctx.sessionManager.getSessionId()),
          projectRoot: ctx.cwd,
          onObservation: (observation) => {
            const key = `${observation.status.generation}:${observation.status.state}`;
            const now = Date.now();
            const intervalMs = (params.updateIntervalSeconds ?? 5) * 1_000;
            if (key !== lastKey || now - lastUpdateAt >= intervalMs) {
              lastKey = key;
              lastUpdateAt = now;
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `${formatObservationProgress(observation)} waited=${Math.floor(
                      (now - startedAt) / 1_000,
                    )}s`,
                  },
                ],
                details: observation,
              });
            }
          },
        },
      );

      if (result.state === "failed" && result.generation !== null) {
        deps.recordHandledFailure(
          ctx.sessionManager.getSessionId(),
          failureEngagementKeyParts(result.instance?.token ?? null, result.generation),
        );
      }

      return {
        content: [{ type: "text", text: formatObservation(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "watcher_output",
    label: "Watcher Output",
    description:
      "Retrieve bounded task output for an exact Funzzy generation; use watcher_status or watcher_observe for state, this is not a status call",
    promptSnippet: "Retrieve bounded Funzzy task output for an exact generation",
    promptGuidelines: [
      "Call watcher_output only to diagnose failure evidence for an exact generation; never as a default status call.",
      "Pass the generation from watcher_observe or watcher_verify; add task to narrow to one task and stream to stdout/stderr.",
    ],
    parameters: Type.Object({
      generation: Type.Integer({
        minimum: 0,
        description: "Exact Funzzy generation to retrieve",
      }),
      task: Type.Optional(
        Type.String({ description: "Restrict retrieval to one task name within the generation" }),
      ),
      stream: Type.Optional(
        Type.Union([
          Type.Literal("stdout", { description: "Standard output stream only" }),
          Type.Literal("stderr", { description: "Standard error stream only" }),
        ]),
      ),
      tail: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 500,
          description: "Last N lines to include (default 40)",
        }),
      ),
      full: Type.Optional(
        Type.Boolean({ description: "Return every retained line (still transport-bounded)" }),
      ),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = await deps.requireTrustedConfig(ctx);
      const result = await deps.requestOutput(
        config.socketPath,
        {
          generation: params.generation,
          task: params.task ?? null,
          stream: params.stream ?? null,
          tail: params.tail,
          full: params.full,
        },
        signal,
      );
      return {
        content: [{ type: "text", text: formatWatcherOutput(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "watcher_cancel",
    label: "Watcher Cancel",
    description:
      "Cancel the exact Funzzy generation (compare-and-cancel); stale requests never affect newer runs",
    promptSnippet: "Cancel an exact Funzzy generation by identity",
    promptGuidelines: [
      "Call watcher_cancel with the exact generation from watcher_observe or watcher_verify to stop a running generation and its descendants.",
      "A stale generation is a safe no-op: the server only cancels when the generation and watcher instance still match.",
    ],
    parameters: Type.Object({
      generation: Type.Integer({
        minimum: 0,
        description: "Exact Funzzy generation to cancel",
      }),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = await deps.requireTrustedConfig(ctx);
      const result = await deps.cancelGeneration(
        config,
        params.generation,
        (params.timeoutSeconds ?? 3) * 1_000,
      );
      return {
        content: [{ type: "text", text: formatCancellation(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "watcher_verify",
    label: "Watcher Verify",
    description:
      "Run the exact named Funzzy target and return its terminal result with freshness proof; use watcher_targets to discover exact names",
    promptSnippet: "Run the external Funzzy final verification gate",
    promptGuidelines: [
      "Select targets by exact name: substring ambiguity returns candidates instead of running work.",
      "Accept green only when the watcher instance is continuous, the snapshot is fresh, and the worktree fingerprint is unchanged.",
    ],
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Exact Funzzy target name" })),
      matchMode: Type.Optional(
        Type.Union([
          Type.Literal("exact", { description: "Only exact target names match" }),
          Type.Literal("substring", {
            description: "Allow one unambiguous substring match (explicit opt-in)",
          }),
        ]),
      ),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = await deps.requireTrustedConfig(ctx);
      const targets = await deps.listTargets(config.socketPath);
      const requested = params.target ?? "@agent-final";
      const matchMode = params.matchMode === "substring" ? "substring" : "exact";
      const selection = selectTarget(targets, requested, matchMode);
      if (selection.kind === "missing") {
        const candidates =
          selection.candidates.length > 0 ? `; candidates: ${selection.candidates.join(", ")}` : "";
        throw new Error(`No exact Funzzy target named "${requested}"${candidates}`);
      }
      if (selection.kind === "ambiguous") {
        throw new Error(
          `Funzzy target "${requested}" is ambiguous; matches: ${selection.candidates.join(", ")}. Pass the exact target name.`,
        );
      }

      const fingerprint = () =>
        deps.worktreeFingerprint(ctx.cwd, (command, args, options) =>
          pi.exec(command, args, { ...options, signal }),
        );

      // Cancellation effect: record the exact run generation as soon as the
      // port knows it, then send compare-and-cancel on abort. Observation-only
      // tools never reach this; the effect only fires after run identity is
      // known, and a stale generation is a safe no-op server-side.
      const CANCEL_ACK_TIMEOUT_MS = 3_000;
      let generation: number | null = null;
      let cancelPromise: Promise<WatcherCancelResult> | null = null;
      let abortListener: (() => void) | null = null;
      const armCancel = (): void => {
        if (cancelPromise !== null || generation === null) return;
        cancelPromise = deps.cancelGeneration(config, generation, CANCEL_ACK_TIMEOUT_MS);
      };
      if (signal !== undefined) {
        abortListener = () => armCancel();
        signal.addEventListener("abort", abortListener, { once: true });
      }

      let verification;
      try {
        verification = await deps.verifyRequest(
          config,
          {
            target: selection.target.name,
            matchMode,
            timeoutMs: (params.timeoutSeconds ?? 120) * 1_000,
          },
          fingerprint,
          signal,
          (runId) => {
            generation = runId;
            armCancel();
          },
        );
      } finally {
        if (abortListener !== null) signal?.removeEventListener("abort", abortListener);
      }

      if (verification.reason === "failed" && verification.generation !== null) {
        deps.recordHandledFailure(
          ctx.sessionManager.getSessionId(),
          failureEngagementKeyParts(verification.instance?.token ?? null, verification.generation),
        );
      }

      if (verification.reason !== "passed") {
        let cancelReport: string | null = null;
        if (cancelPromise !== null) {
          cancelReport = await resolveCancellation(cancelPromise);
        }
        const needsReport = verification.reason === "aborted" || cancelReport !== null;
        const cleanup = needsReport ? ` ${cancelReport ?? "cleanup=none"}` : "";
        throw new Error(`${formatVerification(verification)}${cleanup}`);
      }

      return {
        content: [{ type: "text", text: formatVerification(verification) }],
        details: verification,
      };
    },
  });
}

async function resolveCancellation(promise: Promise<WatcherCancelResult>): Promise<string> {
  return cancellationReport(await promise);
}
