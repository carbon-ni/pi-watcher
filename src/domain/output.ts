import {
  describeValue,
  expectObject,
  readRequiredNumber,
  WatcherProtocolError,
} from "./protocol.js";

export { WatcherProtocolError } from "./protocol.js";

/**
 * Output vocabulary (contract §6): one bounded retrieval of retained task
 * output for an exact generation, optionally narrowed by task and stream.
 * Pure domain: decoding validates every field and fails closed, the client
 * tail/full bounds are decided here, and presentation preserves line
 * boundaries without ANSI or terminal-width dependence.
 *
 * Non-UTF8 policy: raw bytes are converted to JSON strings server-side
 * (lossy); a non-string line here is a protocol violation and fails closed.
 */

export type WatcherOutputStream = "stdout" | "stderr";

export const OUTPUT_STREAMS: readonly WatcherOutputStream[] = ["stdout", "stderr"] as const;

/** Default tail when neither `tail` nor `full` is given. */
export const DEFAULT_OUTPUT_TAIL = 40;

export interface WatcherOutputRequest {
  generation: number;
  /** null = whole generation; a name narrows to one task's output. */
  task?: string | null;
  /** null = both streams; a value narrows to stdout or stderr. */
  stream?: WatcherOutputStream | null;
  /** Last N lines; default 40; ignored when full is set. */
  tail?: number;
  /** Return every retained line (still transport-bounded by the server). */
  full?: boolean;
}

export interface WatcherOutputResult {
  /** Exact selected identity echoed by the server. */
  generation: number;
  task: string | null;
  stream: WatcherOutputStream | null;
  /** Bytes the server observed for the selected identity. */
  observedBytes: number;
  /** Bytes still retained when the server answered (eviction drops these). */
  retainedBytes: number;
  /** True when retained output was dropped before retrieval. */
  evicted: boolean;
  /** Lines delivered by the server, before client-side tail bounds. */
  lines: string[];
  /** True when the server or the client tail/full bounds cut lines. */
  truncated: boolean;
}

/**
 * Decode an `output` method result from `unknown`.
 *
 * Wire shape is the agreed additive contract
 * (`src/domain/fixtures/output.json`, mirrored by Rust protocol tests):
 * generation/task/stream identity plus observed/retained bytes, eviction,
 * server-side truncation, and the retained lines.
 */
export function decodeWatcherOutput(value: unknown): WatcherOutputResult {
  const object = expectObject(value, "output response");

  const generation = readRequiredNumber(object, "generation", "output response");
  const task = readNullableString(object, "task", "output response");
  const stream = readOptionalStream(object);
  const observedBytes = readRequiredNumber(object, "observedBytes", "output response");
  const retainedBytes = readRequiredNumber(object, "retainedBytes", "output response");
  const evicted = readRequiredBoolean(object, "evicted", "output response");
  const truncated = readRequiredBoolean(object, "truncated", "output response");
  const lines = readLineArray(object);

  return {
    generation,
    task,
    stream,
    observedBytes,
    retainedBytes,
    evicted,
    truncated,
    lines,
  };
}

/**
 * Apply the client-side tail/full bounds deterministically. The server may
 * already have truncated (transport or retention caps); that flag is kept,
 * and cutting here marks truncation as well.
 */
export function boundOutputLines(
  result: WatcherOutputResult,
  request: WatcherOutputRequest,
): WatcherOutputResult {
  if (request.full) return result;

  const tail = request.tail ?? DEFAULT_OUTPUT_TAIL;
  if (tail < 0 || !Number.isInteger(tail)) {
    throw new WatcherProtocolError(`Funzzy output request: "tail" must be a non-negative integer`);
  }
  if (tail === 0) {
    return { ...result, lines: [], truncated: true };
  }
  if (result.lines.length <= tail) return result;

  return {
    ...result,
    lines: result.lines.slice(-tail),
    truncated: true,
  };
}

/** Compact content projection used by tool content. */
export function formatWatcherOutput(result: WatcherOutputResult): string {
  const identity = `gen=${result.generation} task=${result.task ?? "all"} stream=${
    result.stream ?? "all"
  }`;
  const bytes = ` retained=${result.retainedBytes} observed=${result.observedBytes}`;
  const flags = `${result.evicted ? " evicted" : ""}${result.truncated ? " truncated" : ""}`;
  const header = `OUTPUT ${identity}${bytes}${flags}`;
  if (result.lines.length === 0) return header;
  return `${header}\n${result.lines.map((line) => `  ${line}`).join("\n")}`;
}

/** Raised when the watcher cannot produce output for a generation. */
export class WatcherOutputNotFoundError extends Error {
  constructor(readonly generation: number) {
    super(`Funzzy output for generation ${generation} is not available`);
    this.name = "WatcherOutputNotFoundError";
  }
}

/** Raised when a task within a known generation has no retained output. */
export class WatcherOutputTaskNotFoundError extends Error {
  constructor(
    readonly generation: number,
    readonly task: string,
  ) {
    super(`Funzzy output for task "${task}" in generation ${generation} is not available`);
    this.name = "WatcherOutputTaskNotFoundError";
  }
}

/** Raised when the negotiated watcher lacks the outputRetrieval feature. */
export class WatcherOutputUnavailableError extends Error {
  constructor() {
    super("Funzzy watcher does not support retained output retrieval");
    this.name = "WatcherOutputUnavailableError";
  }
}

function readNullableString(
  object: Record<string, unknown>,
  field: string,
  what: string,
): string | null {
  if (!(field in object)) {
    throw new WatcherProtocolError(`Funzzy ${what}: "${field}" is required`);
  }
  const value = object[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new WatcherProtocolError(
      `Funzzy ${what}: "${field}" must be a string or null, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readOptionalStream(object: Record<string, unknown>): WatcherOutputStream | null {
  const value = object["stream"];
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && OUTPUT_STREAMS.includes(value as WatcherOutputStream)) {
    return value as WatcherOutputStream;
  }
  throw new WatcherProtocolError(
    `Funzzy output response: "stream" must be one of ${OUTPUT_STREAMS.join(", ")} or null, got ${describeValue(value)}`,
  );
}

function readRequiredBoolean(
  object: Record<string, unknown>,
  field: string,
  what: string,
): boolean {
  if (!(field in object)) {
    throw new WatcherProtocolError(`Funzzy ${what}: "${field}" is required`);
  }
  const value = object[field];
  if (typeof value !== "boolean") {
    throw new WatcherProtocolError(
      `Funzzy ${what}: "${field}" must be a boolean, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readLineArray(object: Record<string, unknown>): string[] {
  const field = "lines";
  if (!(field in object)) {
    throw new WatcherProtocolError(`Funzzy output response: "${field}" is required`);
  }
  const value = object[field];
  if (!Array.isArray(value)) {
    throw new WatcherProtocolError(
      `Funzzy output response: "${field}" must be an array of strings, got ${describeValue(value)}`,
    );
  }
  const lines: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      throw new WatcherProtocolError(
        `Funzzy output response: line at index ${index} must be a string, got ${describeValue(entry)}`,
      );
    }
    lines.push(entry);
  }
  return lines;
}
