import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { exposesWatcherTools, WATCHER_TOOL_NAMES } from "./domain/watcher-gate.js";
import type { WatcherConfigPresence } from "./domain/watcher-gate.js";

/** Minimal Pi surface needed to activate/deactivate the registered tools. */
export interface ToolActivationPort {
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
}

export interface WatcherRegistrationDeps {
  /** Existence-only gate probe (infra adapter; never parses the contract). */
  readConfigPresence: (cwd: string) => Promise<WatcherConfigPresence>;
  /** Register all watcher tools; Pi replaces same-name definitions, so this is name-idempotent. */
  registerWatcherTools: () => void;
  /** Start the polling lifecycle (status bar, follow-ups) for a gated-in session. */
  startWatcherSession: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
  /** Reset lifecycle state and clear the status bar without starting anything. */
  resetWatcherSession: (ctx: ExtensionContext) => Promise<void>;
}

export interface WatcherRegistration {
  sessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
}

/**
 * Lazy, idempotent registration of the watcher surface.
 *
 * Pi cannot unregister dynamically registered tools: once registered they stay
 * in `pi.getAllTools()` for the whole session. Closing the gate therefore
 * deactivates the watcher tools through `setActiveTools` (dropping them from
 * the active set and the system prompt) instead of unregistering them, and a
 * later re-open re-activates the same registrations.
 */
export function createWatcherRegistration(
  pi: ToolActivationPort,
  deps: WatcherRegistrationDeps,
): WatcherRegistration {
  const watcherToolNames = new Set<string>(WATCHER_TOOL_NAMES);
  let registered = false;

  const ensureWatcherToolsActive = (): void => {
    const active = pi.getActiveTools();
    const missing = WATCHER_TOOL_NAMES.filter((name) => !active.includes(name));
    if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
  };

  const deactivateWatcherTools = (): void => {
    const active = pi.getActiveTools();
    const remaining = active.filter((name) => !watcherToolNames.has(name));
    if (remaining.length !== active.length) pi.setActiveTools(remaining);
  };

  return {
    async sessionStart(event, ctx) {
      const presence = await deps.readConfigPresence(ctx.cwd);
      if (exposesWatcherTools(presence)) {
        if (registered) ensureWatcherToolsActive();
        else {
          deps.registerWatcherTools();
          registered = true;
        }
        await deps.startWatcherSession(event, ctx);
        return;
      }

      // Gate closed: no tools, no polling, no stale status. Registration
      // cannot be undone (getAllTools keeps them), so deactivate instead.
      if (registered) deactivateWatcherTools();
      await deps.resetWatcherSession(ctx);
    },
  };
}
