import { describe, expect, it, vi } from "vitest";

import type { WatcherObservation } from "./observation.js";
import type { WatcherCorrelatedSnapshot } from "./capabilities.js";
import {
  createFailureNotifier,
  failureDeliveryKey,
  failureDeliveryKeyParts,
  failureEngagementKey,
  failureEngagementKeyParts,
} from "./failure-notifier.js";

const SNAPSHOT: WatcherCorrelatedSnapshot = {
  instance: { token: "fz-7f3a", startedAtEpochMs: 1710000000000 },
  generation: 7,
  batchId: "b-21",
  state: "failed",
  trigger: "src/main.ts",
  commands: ["npm test"],
  tasks: [],
  pending: 0,
  freshness: "current",
  durationMs: 42,
  failures: ["npm test exited with status 1"],
  paths: [],
};

function observation(overrides: Partial<WatcherObservation> = {}): WatcherObservation {
  return {
    sequence: 1,
    status: {
      generation: 7,
      state: "failed",
      trigger: "src/main.ts",
      commands: ["npm test"],
      durationMs: 42,
      failures: ["npm test exited with status 1"],
    },
    source: "subscription",
    freshness: "current",
    snapshot: SNAPSHOT,
    ...overrides,
  };
}

function createFakeDeps() {
  const claimed = new Set<string>();
  return {
    isHandled: vi.fn<(key: string) => boolean>(() => false),
    claimDelivery: vi.fn(async (key: string) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    }),
  };
}

function createNotifier(sessionId: string, deps = createFakeDeps(), sendFailure = vi.fn()) {
  return {
    deps,
    sendFailure,
    notify: createFailureNotifier(sessionId, sendFailure, deps),
  };
}

describe("createFailureNotifier", () => {
  it("delivers each owned failed generation once when the agent is idle", async () => {
    const { deps, sendFailure, notify } = createNotifier("session-a");
    const failed = observation();

    expect(await notify(failed, true, "session-a")).toBe(true);
    expect(await notify(failed, true, "session-a")).toBe(false);
    expect(sendFailure).toHaveBeenCalledTimes(1);
    expect(deps.claimDelivery).toHaveBeenCalledTimes(1);
  });

  it("holds an owned failure until the agent becomes idle", async () => {
    const { deps, sendFailure, notify } = createNotifier("session-a");
    const failed = observation();

    expect(await notify(failed, false, "session-a")).toBe(false);
    expect(await notify(failed, true, "session-a")).toBe(true);
    expect(sendFailure).toHaveBeenCalledTimes(1);
    expect(deps.claimDelivery).toHaveBeenCalledTimes(1);
  });

  it("does not deliver non-failure status into agent context", async () => {
    const { sendFailure, notify } = createNotifier("session-a");

    expect(
      await notify(
        observation({ status: { ...observation().status, state: "passed" } }),
        true,
        "session-a",
      ),
    ).toBe(false);
    expect(sendFailure).not.toHaveBeenCalled();
  });

  it("does not deliver a failure owned by another session", async () => {
    const { sendFailure, notify } = createNotifier("session-b");

    expect(await notify(observation(), true, "session-a")).toBe(false);
    expect(sendFailure).not.toHaveBeenCalled();
  });

  it("does not deliver a stale-freshness failure", async () => {
    const { sendFailure, notify } = createNotifier("session-a");

    expect(await notify(observation({ freshness: "stale" }), true, "session-a")).toBe(false);
    expect(sendFailure).not.toHaveBeenCalled();
  });

  it("skips a generation the session is already observing or verifying", async () => {
    const { deps, sendFailure, notify } = createNotifier("session-a");
    deps.isHandled.mockReturnValue(true);

    expect(await notify(observation(), true, "session-a")).toBe(false);
    expect(deps.claimDelivery).not.toHaveBeenCalled();
    expect(sendFailure).not.toHaveBeenCalled();
  });

  it("skips when another session claimed the same failure first", async () => {
    const shared = new Set<string>();
    const claimDelivery = vi.fn(async (key: string) => {
      if (shared.has(key)) return false;
      shared.add(key);
      return true;
    });
    const sendFailure = vi.fn();
    const firstNotifier = createFailureNotifier("session-a", sendFailure, {
      isHandled: () => false,
      claimDelivery,
    });
    const secondNotifier = createFailureNotifier("session-b", vi.fn(), {
      isHandled: () => false,
      claimDelivery,
    });
    const failed = observation();

    const firstResult = await firstNotifier(failed, true, "session-a");
    const secondResult = await secondNotifier(failed, true, "session-b");

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(false);
    expect(sendFailure).toHaveBeenCalledTimes(1);
  });

  it("delivers at most once across two concurrent sessions sharing one claim", async () => {
    const shared = new Set<string>();
    const claimDelivery = vi.fn(async (key: string) => {
      if (shared.has(key)) return false;
      shared.add(key);
      return true;
    });
    const results = await Promise.all([
      createFailureNotifier("session-a", vi.fn(), { isHandled: () => false, claimDelivery })(
        observation(),
        true,
        "session-a",
      ),
      createFailureNotifier("session-b", vi.fn(), { isHandled: () => false, claimDelivery })(
        observation(),
        true,
        "session-b",
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not re-deliver a replayed snapshot of the same delivered generation", async () => {
    const { sendFailure, notify } = createNotifier("session-a");
    const failed = observation();

    await notify(failed, true, "session-a");
    // Reconnect replay: same failure, new transport sequence.
    await notify(observation({ sequence: 99 }), true, "session-a");

    expect(sendFailure).toHaveBeenCalledTimes(1);
  });

  it("delivers a fresh failure on a new watcher instance with the same generation", async () => {
    const { sendFailure, notify } = createNotifier("session-a");
    const deps = createFakeDeps();
    const notify2 = createFailureNotifier("session-a", sendFailure, deps);

    await notify(observation(), true, "session-a");
    // Watcher restarted: same generation number, new instance token.
    await notify2(
      observation({
        snapshot: { ...SNAPSHOT, instance: { token: "fz-9b21", startedAtEpochMs: 0 } },
      }),
      true,
      "session-a",
    );

    expect(sendFailure).toHaveBeenCalledTimes(2);
  });
});

describe("failureEngagementKey", () => {
  it("keys subscription engagement by instance token and generation", () => {
    expect(failureEngagementKey(observation())).toBe("fz-7f3a:7");
  });

  it("keys legacy engagement by generation only so bounded tool evidence still matches", () => {
    const legacy = observation({ source: "polled", snapshot: null });
    expect(failureEngagementKey(legacy)).toBe("legacy:7");
    expect(failureEngagementKeyParts(null, 7)).toBe("legacy:7");
    expect(failureEngagementKeyParts("fz-7f3a", 7)).toBe("fz-7f3a:7");
  });
});

describe("failureDeliveryKey", () => {
  it("keys subscription failures by instance token and generation", () => {
    expect(failureDeliveryKey(observation())).toBe("fz-7f3a:7");
    expect(failureDeliveryKey(observation({ sequence: 5 }))).toBe("fz-7f3a:7");
  });

  it("keys legacy failures by generation plus a failure signature", () => {
    const legacy = observation({
      source: "polled",
      snapshot: null,
    });
    const sameFailure = observation({ source: "polled", snapshot: null, sequence: 3 });
    const differentFailure = observation({
      source: "polled",
      snapshot: null,
      status: { ...observation().status, failures: ["another boom"] },
    });

    expect(failureDeliveryKey(legacy)).toBe(failureDeliveryKey(sameFailure));
    expect(failureDeliveryKey(legacy)).not.toBe(failureDeliveryKey(differentFailure));
  });

  it("keeps the key parts helper consistent with the observation builder", () => {
    expect(failureDeliveryKeyParts("fz-7f3a", 7, ["boom"])).toBe(
      failureDeliveryKey(observation({ status: { ...observation().status, failures: ["boom"] } })),
    );
  });
});
