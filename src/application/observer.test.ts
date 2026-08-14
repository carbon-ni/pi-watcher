import { afterEach, describe, expect, it, vi } from "vitest";

import { createObserver, type ObserverPort } from "./observer.js";
import type { WatcherObservation } from "../domain/observation.js";

const OBSERVATION: WatcherObservation = {
  sequence: 1,
  status: {
    generation: 4,
    state: "running",
    trigger: "src/main.rs",
    commands: ["cargo test"],
    durationMs: null,
    failures: [],
  },
  source: "subscription",
  freshness: "current",
  snapshot: null,
};

/** One controllable stream per port.open call. */
class ScriptedStream {
  private queue: WatcherObservation[] = [];
  private waiters: Array<(value: WatcherObservation | undefined) => void> = [];
  private settled: "end" | Error | null = null;

  constructor(private readonly signal: AbortSignal) {}

  push(observation: WatcherObservation): void {
    if (this.settled !== null) throw new Error("stream already settled");
    const waiter = this.waiters.shift();
    if (waiter) waiter(observation);
    else this.queue.push(observation);
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
  return {
    port,
    opens: () => streams.length,
    stream: () => streams[streams.length - 1]!,
  };
}

function createHarness(options: { maxAttempts?: number } = {}) {
  const scripted = createScriptedPort();
  const sink = {
    onObservation: vi.fn<(observation: WatcherObservation) => void>(),
    onUnavailable: vi.fn<(reason: string) => void>(),
  };
  const observer = createObserver({
    port: scripted.port,
    sink,
    reconnectBaseMs: 250,
    reconnectMaxMs: 2_000,
    maxReconnectAttempts: options.maxAttempts ?? 8,
    random: () => 0,
  });
  return { observer, sink, scripted };
}

/** Flush enough microtask rounds for the observer to process every push. */
async function flushStream(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("initial snapshot and dedupe", () => {
  it("delivers the immediate snapshot and only newer sequences after it", async () => {
    const { observer, sink, scripted } = createHarness();
    const start = observer.start();

    scripted.stream().push(OBSERVATION);
    await start;
    scripted.stream().push({ ...OBSERVATION, sequence: 1 }); // duplicate
    scripted.stream().push({ ...OBSERVATION, sequence: 3 }); // newer
    await flushStream();

    expect(sink.onObservation).toHaveBeenCalledTimes(2);
    expect(sink.onObservation.mock.calls.map(([obs]) => obs.sequence)).toEqual([1, 3]);
  });

  it("ignores an out-of-order older sequence", async () => {
    const { observer, sink, scripted } = createHarness();
    const start = observer.start();
    scripted.stream().push({ ...OBSERVATION, sequence: 5 });
    await start;
    scripted.stream().push(OBSERVATION);
    await flushStream();

    expect(sink.onObservation).toHaveBeenCalledTimes(1);
  });
});

describe("reconnect", () => {
  it("reconnects with bounded backoff after the transport drops", async () => {
    vi.useFakeTimers();
    const { observer, sink, scripted } = createHarness();
    const start = observer.start();
    scripted.stream().push(OBSERVATION);
    await start;

    scripted.stream().end();
    await flushStream();
    expect(sink.onUnavailable).toHaveBeenCalledWith(
      "watcher disconnected; reconnecting (attempt 1)",
    );

    await vi.advanceTimersByTimeAsync(250);
    expect(scripted.opens()).toBe(2);
    scripted.stream().push({ ...OBSERVATION, sequence: 2 });
    await flushStream();
    expect(sink.onObservation).toHaveBeenCalledTimes(2);
  });

  it("reports the transport error reason and reconnects", async () => {
    vi.useFakeTimers();
    const { observer, sink, scripted } = createHarness();
    const start = observer.start();
    scripted.stream().push(OBSERVATION);
    await start;

    scripted.stream().fail(new Error("socket gone"));
    await flushStream();
    expect(sink.onUnavailable).toHaveBeenCalledWith(
      "watcher unavailable (socket gone); reconnecting (attempt 1)",
    );

    await vi.advanceTimersByTimeAsync(250);
    expect(scripted.opens()).toBe(2);
  });

  it("backs off exponentially across consecutive disconnects", async () => {
    vi.useFakeTimers();
    const { observer, sink, scripted } = createHarness();
    const start = observer.start();
    scripted.stream().push(OBSERVATION);
    await start;

    scripted.stream().end();
    await flushStream();
    await vi.advanceTimersByTimeAsync(250); // attempt 1 -> open 2
    scripted.stream().end();
    await flushStream();
    expect(sink.onUnavailable).toHaveBeenLastCalledWith(
      "watcher disconnected; reconnecting (attempt 2)",
    );
    await vi.advanceTimersByTimeAsync(500); // attempt 2 -> open 3

    expect(scripted.opens()).toBe(3);
  });

  it("resets the backoff after a successful observation", async () => {
    vi.useFakeTimers();
    const { observer, sink, scripted } = createHarness();
    const start = observer.start();
    scripted.stream().push(OBSERVATION);
    await start;

    scripted.stream().end();
    await flushStream();
    await vi.advanceTimersByTimeAsync(250); // attempt 1 -> open 2
    scripted.stream().push({ ...OBSERVATION, sequence: 2 }); // reconnect succeeded
    await flushStream();
    scripted.stream().end();
    await flushStream();

    // A fresh disconnect after a successful observation starts at attempt 1 again.
    expect(sink.onUnavailable).toHaveBeenLastCalledWith(
      "watcher disconnected; reconnecting (attempt 1)",
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(scripted.opens()).toBe(3);
  });

  it("stops after the bounded reconnect attempts and reports final unavailable", async () => {
    vi.useFakeTimers();
    const { observer, sink, scripted } = createHarness({ maxAttempts: 3 });
    const start = observer.start();
    scripted.stream().push(OBSERVATION);
    await start;

    scripted.stream().end();
    await flushStream();
    await vi.advanceTimersByTimeAsync(250); // attempt 1 -> open 2
    scripted.stream().end();
    await flushStream();
    await vi.advanceTimersByTimeAsync(500); // attempt 2 -> open 3
    scripted.stream().end();
    await flushStream();

    expect(scripted.opens()).toBe(3);
    expect(sink.onUnavailable).toHaveBeenLastCalledWith(
      "watcher unavailable after 3 reconnect attempts",
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(scripted.opens()).toBe(3);
  });
});

describe("lifecycle", () => {
  it("keeps only one active observation stream per start", async () => {
    const { observer, scripted } = createHarness();
    const first = observer.start();
    scripted.stream().push(OBSERVATION);
    await first;

    const second = observer.start();
    await second;

    expect(scripted.opens()).toBe(1);
  });

  it("aborts the stream and drops late in-flight observations on dispose", async () => {
    const { observer, sink, scripted } = createHarness();
    const start = observer.start();
    scripted.stream().push(OBSERVATION);
    await start;

    observer.dispose();
    scripted.stream().push({ ...OBSERVATION, sequence: 2 });

    expect(sink.onObservation).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending reconnect timer on dispose", async () => {
    vi.useFakeTimers();
    const { observer, scripted } = createHarness();
    const start = observer.start();
    scripted.stream().push(OBSERVATION);
    await start;

    scripted.stream().end();
    await flushStream();
    observer.dispose();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(scripted.opens()).toBe(1);
  });

  it("restarts with a fresh stream after dispose", async () => {
    const { observer, sink, scripted } = createHarness();
    const start = observer.start();
    scripted.stream().push(OBSERVATION);
    await start;

    observer.dispose();
    const restart = observer.start();
    scripted.stream().push({ ...OBSERVATION, sequence: 9 });

    await restart;
    await flushStream();
    expect(scripted.opens()).toBe(2);
    expect(sink.onObservation).toHaveBeenCalledTimes(2);
    expect(sink.onObservation.mock.calls.at(-1)![0].sequence).toBe(9);
  });

  it("resolves a pending start when the stream fails before any observation", async () => {
    const { observer, sink, scripted } = createHarness();
    const start = observer.start();
    scripted.stream().fail(new Error("refused"));

    await start;
    expect(sink.onUnavailable).toHaveBeenCalled();
    expect(sink.onObservation).not.toHaveBeenCalled();
  });
});
