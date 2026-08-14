import { afterEach, describe, expect, it, vi } from "vitest";

import type { ObserverPort } from "./observer.js";
import { requestObservation } from "./observe.js";
import type { WatcherObservation } from "../domain/observation.js";
import { observationResult } from "../domain/observation-result.js";
import type { WatcherFreshness, WatcherCorrelatedSnapshot } from "../domain/capabilities.js";
import type { WatcherExecutionState } from "../domain/watcher.js";

const SNAPSHOT: WatcherCorrelatedSnapshot = {
  instance: { token: "fz-7f3a", startedAtEpochMs: 1710000000000 },
  generation: 5,
  batchId: "b-21",
  state: "running",
  trigger: "src/index.ts",
  commands: ["make all"],
  tasks: [{ id: "t-1", name: "lint", state: "passed", durationMs: null }],
  pending: 1,
  freshness: "current",
  durationMs: null,
  failures: [],
};

interface ObservationOverrides {
  status?: Partial<WatcherObservation["status"]>;
  snapshot?: WatcherObservation["snapshot"];
  freshness?: WatcherFreshness;
}

function observation(
  generation: number,
  state: WatcherExecutionState,
  overrides: ObservationOverrides = {},
): WatcherObservation {
  return {
    sequence: generation,
    status: {
      generation,
      state,
      trigger: "src/index.ts",
      commands: ["make all"],
      durationMs: state === "passed" ? 42 : null,
      failures: [],
      ...(overrides.status ?? {}),
    },
    source: "subscription",
    freshness: overrides.freshness ?? "current",
    snapshot: overrides.snapshot ?? {
      ...SNAPSHOT,
      generation,
      state,
      durationMs: state === "passed" ? 42 : null,
    },
  };
}

class ScriptedStream {
  private queue: WatcherObservation[] = [];
  private waiters: Array<(value: WatcherObservation | undefined) => void> = [];
  private settled: "end" | Error | null = null;

  constructor(private readonly signal: AbortSignal) {}

  push(value: WatcherObservation): void {
    if (this.settled !== null) throw new Error("stream already settled");
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.queue.push(value);
  }

  end(): void {
    if (this.settled !== null) return;
    this.settled = "end";
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  fail(error: Error): void {
    if (this.settled !== null) return;
    this.settled = error;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  async *generator(): AsyncGenerator<WatcherObservation> {
    while (true) {
      if (this.signal.aborted) return;
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.settled === "end") return;
      if (this.settled instanceof Error) throw this.settled;
      const value = await new Promise<WatcherObservation | undefined>((resolve) => {
        const onAbort = (): void => resolve(undefined);
        this.signal.addEventListener("abort", onAbort, { once: true });
        this.waiters.push((v) => {
          this.signal.removeEventListener("abort", onAbort);
          resolve(v);
        });
      });
      if (value !== undefined) {
        yield value;
        continue;
      }
      // Unblocked by end/fail/abort; loop re-checks settled and aborted state.
    }
  }
}

function createScriptedPort() {
  const streams: ScriptedStream[] = [];
  const port: ObserverPort = {
    open(signal) {
      const stream = new ScriptedStream(signal);
      streams.push(stream);
      return stream.generator();
    },
  };
  return { port, stream: () => streams[streams.length - 1]! };
}

function createHarness() {
  const scripted = createScriptedPort();
  const onObservation = vi.fn<(observation: WatcherObservation) => void>();
  return {
    scripted,
    onObservation,
    deps: {
      port: scripted.port,
      onObservation,
      classifyError: (error: unknown) =>
        error instanceof Error && /disconnect|unavailable|socket/.test(error.message)
          ? ("disconnect" as const)
          : ("unknown" as const),
    },
  };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("requestObservation snapshot mode", () => {
  it("returns the first observation as a snapshot with typed details", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: false }, deps);
    await flush();
    scripted.stream().push(observation(5, "running"));

    const result = await promise;

    expect(result.outcome).toBe("snapshot");
    expect(result.generation).toBe(5);
    expect(result.state).toBe("running");
    expect(result.batchId).toBe("b-21");
    expect(result.instance).toEqual({ token: "fz-7f3a", startedAtEpochMs: 1710000000000 });
  });

  it("labels a stale snapshot explicitly instead of trusting it", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: false }, deps);
    await flush();
    scripted.stream().push(observation(5, "passed", { freshness: "stale" }));

    expect((await promise).outcome).toBe("stale");
  });

  it("does not report progress in snapshot mode", async () => {
    const { scripted, deps, onObservation } = createHarness();
    const promise = requestObservation({ wait: false }, deps);
    await flush();
    scripted.stream().push(observation(5, "passed"));

    await promise;
    expect(onObservation).not.toHaveBeenCalled();
  });
});

describe("requestObservation wait mode", () => {
  it("returns immediately when the first observation is already terminal", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: true }, deps);
    await flush();
    scripted.stream().push(observation(5, "passed"));

    const result = await promise;
    expect(result.outcome).toBe("terminal");
    expect(result.state).toBe("passed");
  });

  it("reports an explicit no-op when nothing is pending or running", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: true }, deps);
    await flush();
    scripted.stream().push(
      observation(0, "idle", {
        snapshot: { ...SNAPSHOT, generation: 0, state: "idle", pending: 0 },
      }),
    );

    const result = await promise;
    expect(result.outcome).toBe("noop");
    expect(result.generation).toBe(0);
  });

  it("keeps waiting while running and completes on the terminal state", async () => {
    const { scripted, deps, onObservation } = createHarness();
    const promise = requestObservation({ wait: true }, deps);
    await flush();
    scripted.stream().push(observation(5, "running"));
    await flush();
    scripted.stream().push(observation(5, "passed"));

    const result = await promise;
    expect(result.outcome).toBe("terminal");
    expect(result.generation).toBe(5);
    expect(onObservation).toHaveBeenCalledTimes(2);
  });

  it("waits for the first generation newer than afterGeneration", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: true, afterGeneration: 4 }, deps);
    await flush();
    scripted.stream().push(observation(4, "passed"));
    await flush();
    scripted.stream().push(observation(5, "passed"));

    const result = await promise;
    expect(result.outcome).toBe("terminal");
    expect(result.generation).toBe(5);
  });

  it("waits for the next run from an idle start when afterGeneration is 0", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: true, afterGeneration: 0 }, deps);
    await flush();
    scripted.stream().push(observation(0, "idle"));
    await flush();
    scripted.stream().push(observation(1, "running"));
    await flush();
    scripted.stream().push(observation(1, "passed"));

    const result = await promise;
    expect(result.outcome).toBe("terminal");
    expect(result.generation).toBe(1);
  });

  it("reports superseded when the latched fresh generation is replaced while running", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: true, afterGeneration: 4 }, deps);
    await flush();
    scripted.stream().push(observation(5, "running"));
    await flush();
    scripted.stream().push(observation(6, "running"));

    const result = await promise;
    expect(result.outcome).toBe("superseded");
    expect(result.generation).toBe(6);
    expect(result.supersedingGeneration).toBe(6);
  });

  it("reports superseded when the anchored generation is replaced before terminal", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: true }, deps);
    await flush();
    scripted.stream().push(observation(5, "running"));
    await flush();
    scripted.stream().push(observation(6, "running"));

    const result = await promise;
    expect(result.outcome).toBe("superseded");
    expect(result.supersedingGeneration).toBe(6);
  });

  it("times out without an observation and keeps the last known state", async () => {
    vi.useFakeTimers();
    const { scripted, deps } = createHarness();
    const promise = requestObservation(
      { wait: true, timeoutMs: 30_000 },
      { ...deps, now: () => Date.now() },
    );
    await flush();
    scripted.stream().push(observation(5, "running"));

    await vi.advanceTimersByTimeAsync(30_000);

    const result = await promise;
    expect(result.outcome).toBe("timeout");
    expect(result.generation).toBe(5);
  });

  it("returns aborted when the AbortSignal fires during the wait", async () => {
    const { scripted, deps } = createHarness();
    const controller = new AbortController();
    const promise = requestObservation({ wait: true }, { ...deps, signal: controller.signal });
    await flush();
    scripted.stream().push(observation(5, "running"));

    controller.abort();
    await flush();

    const result = await promise;
    expect(result.outcome).toBe("aborted");
  });

  it("returns disconnected when the stream ends without abort or timeout", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: true }, deps);
    await flush();
    scripted.stream().push(observation(5, "running"));
    await flush();
    scripted.stream().end();

    const result = await promise;
    expect(result.outcome).toBe("disconnect");
    expect(result.message).toMatch(/disconnected/i);
  });

  it("classifies transport errors as disconnect through the injected classifier", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: true }, deps);
    await flush();
    scripted.stream().push(observation(5, "running"));
    await flush();
    scripted.stream().fail(new Error("Funzzy closed the socket without a complete response"));

    const result = await promise;
    expect(result.outcome).toBe("disconnect");
  });

  it("reports malformed server payloads as unknown with an actionable message", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: true }, deps);
    await flush();
    scripted.stream().fail(new Error('Funzzy correlated snapshot: "generation" must be a number'));

    const result = await promise;
    expect(result.outcome).toBe("unknown");
    expect(result.message).toMatch(/generation/);
  });

  it("labels a stale completing observation instead of trusting it", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: true }, deps);
    await flush();
    scripted.stream().push(observation(5, "passed", { freshness: "stale" }));

    expect((await promise).outcome).toBe("stale");
  });

  it("bounds failure evidence through the request tail", async () => {
    const { scripted, deps } = createHarness();
    const failures = Array.from({ length: 12 }, (_, index) => `failure ${index}`);
    const promise = requestObservation({ wait: true, maxEvidenceLines: 5 }, deps);
    await flush();
    scripted.stream().push(
      observation(5, "failed", {
        status: { ...observation(5, "failed").status, failures },
        snapshot: { ...SNAPSHOT, generation: 5, state: "failed", failures },
      }),
    );

    const result = await promise;
    expect(result.failures).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.nextAction).toBe("watcher_output generation=5");
  });
});

describe("requestObservation observationResult parity", () => {
  it("keeps the pure builder and the use case result shape aligned", async () => {
    const { scripted, deps } = createHarness();
    const promise = requestObservation({ wait: false }, { ...deps, now: () => 1_000 });
    await flush();
    const pushed = observation(5, "running");
    scripted.stream().push(pushed);

    const result = await promise;
    const expected = observationResult(pushed, "snapshot", { waitedMs: 0 });

    expect(result).toEqual(expected);
  });
});
