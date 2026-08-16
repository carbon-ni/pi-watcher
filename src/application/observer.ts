import { shouldForwardObservation, type WatcherObservation } from "../domain/observation.js";

/**
 * Push-driven lifecycle observer (contract §7).
 *
 * Opens one injected observer port per start, forwards only newer sequence
 * observations to the sink, and reconnects with bounded exponential backoff
 * when the transport drops. The port owns transport; this module owns the
 * deterministic policy and never touches sockets. `random` is injected so
 * jitter is reproducible in tests.
 */

export interface ObserverPort {
  /** Open a stream of observations; ends when the transport drops or aborts. */
  open(signal: AbortSignal): AsyncGenerator<WatcherObservation>;
}

export interface ObserverSink {
  onObservation(observation: WatcherObservation): void;
  onUnavailable(reason: string): void;
}

export interface ObserverOptions {
  port: ObserverPort;
  sink: ObserverSink;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxReconnectAttempts?: number;
  random?: () => number;
}

export interface WatcherObserver {
  /**
   * Start observing. Resolves once the immediate snapshot is delivered or an
   * unavailability is reported. Starting an already-active observer is a
   * no-op: only one observation stream is ever active per observer.
   */
  start(): Promise<void>;
  /** Abort the stream, cancel pending reconnect timers, drop state. */
  dispose(): void;
  /** Whether an observation stream is currently active. */
  readonly active: boolean;
}

export function createObserver(options: ObserverOptions): WatcherObserver {
  const { port, sink } = options;
  const baseMs = options.reconnectBaseMs ?? 250;
  const maxMs = options.reconnectMaxMs ?? 4_000;
  const maxAttempts = options.maxReconnectAttempts ?? 8;
  const random = options.random ?? Math.random;

  let controller: AbortController | null = null;
  let disposed = false;
  let running = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastObservation: WatcherObservation | null = null;
  let attempts = 0;
  let startResolved = false;
  let resolveStart: (() => void) | null = null;

  const markStartResolved = (): void => {
    if (startResolved) return;
    startResolved = true;
    resolveStart?.();
    resolveStart = null;
  };

  const backoffMs = (attempt: number): number => {
    const capped = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
    return Math.max(1, Math.round(capped * (0.5 + random() * 0.5)));
  };

  const stop = (): void => {
    running = false;
    markStartResolved();
  };

  const scheduleReconnect = (reason: string): void => {
    if (disposed || !running) return;
    attempts += 1;
    if (attempts >= maxAttempts) {
      sink.onUnavailable(`watcher unavailable after ${maxAttempts} reconnect attempts`);
      stop();
      return;
    }
    sink.onUnavailable(`${reason}; reconnecting (attempt ${attempts})`);
    markStartResolved();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void run();
    }, backoffMs(attempts));
  };

  const run = async (): Promise<void> => {
    if (disposed || !running || controller === null) return;
    const signal = controller.signal;
    try {
      for await (const observation of port.open(signal)) {
        if (disposed || signal.aborted) return;
        if (shouldForwardObservation(lastObservation, observation)) {
          lastObservation = observation;
          attempts = 0;
          sink.onObservation(observation);
          markStartResolved();
        }
      }
      // Stream ended without abort: the transport dropped.
      if (disposed || signal.aborted) return;
      scheduleReconnect("watcher disconnected");
    } catch (error) {
      if (disposed || signal.aborted) return;
      const reason = error instanceof Error ? error.message : String(error);
      scheduleReconnect(`watcher unavailable (${reason})`);
    }
  };

  return {
    start(): Promise<void> {
      if (running) return Promise.resolve();
      disposed = false;
      running = true;
      startResolved = false;
      lastObservation = null;
      attempts = 0;
      controller = new AbortController();
      const startPromise = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      void run();
      return startPromise;
    },

    dispose(): void {
      disposed = true;
      running = false;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      controller?.abort();
      controller = null;
      lastObservation = null;
      attempts = 0;
      markStartResolved();
    },

    get active(): boolean {
      return running;
    },
  };
}
