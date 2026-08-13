import {
  LEGACY_CAPABILITY_PROFILE,
  type WatcherCapabilityProfile,
} from "../domain/capabilities.js";
import { FunzzyRpcError, queryCapabilities } from "./client.js";

/** Token the legacy profile is cached under; no instance identity exists. */
const LEGACY_CAPABILITY_TOKEN = "legacy";

/**
 * Per-instance capability cache. Keyed by the watcher instance token from the
 * negotiated response — never by socket path alone, so a restarted watcher on
 * the same path cannot reuse stale capabilities. Callers invalidate on
 * disconnect or restart identity change.
 */
export class CapabilityCache {
  private byToken = new Map<string, WatcherCapabilityProfile>();
  private lastToken: string | null = null;

  get(token: string): WatcherCapabilityProfile | undefined {
    return this.byToken.get(token);
  }

  set(token: string, profile: WatcherCapabilityProfile): void {
    this.byToken.set(token, profile);
    this.lastToken = token;
  }

  /** Drop every cached profile after a disconnect or restart identity change. */
  invalidate(): void {
    this.byToken.clear();
    this.lastToken = null;
  }

  cached(): WatcherCapabilityProfile | undefined {
    return this.lastToken === null ? undefined : this.byToken.get(this.lastToken);
  }
}

/**
 * Request capabilities once per watcher instance and cache the profile.
 *
 * A server without the `capabilities` method answers -32601 Method not found;
 * that single response is mapped to the explicit legacy profile (contract §8).
 * No side-effectful per-feature probing ever happens: the method-not-found
 * error is the whole negotiation.
 */
export async function loadCapabilities(
  socketPath: string,
  cache: CapabilityCache,
  timeoutMs = 1_000,
): Promise<WatcherCapabilityProfile> {
  const cached = cache.cached();
  if (cached !== undefined) return cached;

  try {
    const profile = await queryCapabilities(socketPath, timeoutMs);
    cache.set(profile.instance.token, profile);
    return profile;
  } catch (error) {
    if (error instanceof FunzzyRpcError && error.code === -32601) {
      cache.set(LEGACY_CAPABILITY_TOKEN, LEGACY_CAPABILITY_PROFILE);
      return LEGACY_CAPABILITY_PROFILE;
    }
    throw error;
  }
}
