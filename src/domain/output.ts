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
 * Pure domain: decoding validates every field and fails closed; the server
 * bounds content (tail or full, default retained tail) and reports
 * observed/retained bytes and truncation per stream.
 *
 * Non-UTF8 policy: raw bytes are converted to JSON strings server-side
 * (lossy); a non-string here is a protocol violation and fails closed.
 */

export type WatcherOutputStream = "stdout" | "stderr";

export const OUTPUT_STREAMS: readonly WatcherOutputStream[] = ["stdout", "stderr"] as const;

export interface WatcherOutputRequest {
  /** Required when following a schema-2 exact output reference. */
  instanceToken?: string;
  generation: number;
  /** null = whole generation; a name narrows to one task's output. */
  task?: string | null;
  /** null = both streams; a value narrows to stdout or stderr. */
  stream?: WatcherOutputStream | null;
  /** Last N lines per stream; default retained tail; ignored when full is set. */
  tail?: number;
  /** Return every retained line (legacy schema-1 only). */
  full?: boolean;
  /** Schema-2 retrieval mode. */
  mode?: "tail" | "page";
  /** Opaque schema-2 continuation cursor. */
  cursor?: string;
  /** Schema-2 response budget, always below transport maximum. */
  maxBytes?: number;
}

export interface WatcherStreamOutput {
  /** Retained lines the server delivered (already tail/full bounded). */
  content: string;
  /** Number of content lines, as counted server-side. */
  lines: number;
  /** Bytes still retained when the server answered (eviction drops these). */
  retainedBytes: number;
  /** Bytes the server observed for the stream. */
  observedBytes: number;
  /** True when the server tail/full bound or retention cut the stream. */
  truncated: boolean;
}

export interface WatcherTaskOutput {
  id: string;
  /** null when the request narrowed to the other stream. */
  stdout: WatcherStreamOutput | null;
  stderr: WatcherStreamOutput | null;
}

export interface WatcherOutputResult {
  /** Exact selected generation echoed by the server. */
  generation: number;
  /** One entry per retained task (whole-generation retrieval) or one selected task. */
  tasks: WatcherTaskOutput[];
}

/**
 * Decode an `output` method result from `unknown`.
 *
 * Wire shape is the agreed additive contract
 * (`src/domain/fixtures/output.json`, mirrored by Rust protocol tests):
 * `{ generation, tasks: [{ id, stdout: StreamOutput|null, stderr: StreamOutput|null }] }`
 * where `StreamOutput` is `{ content, lines, retainedBytes, observedBytes, truncated }`.
 */
export function decodeWatcherOutput(value: unknown): WatcherOutputResult {
  const object = expectObject(value, "output response");

  const generation = readRequiredNumber(object, "generation", "output response");
  const tasksValue = object["tasks"];
  if (!Array.isArray(tasksValue)) {
    throw new WatcherProtocolError(
      `Funzzy output response: "tasks" must be an array, got ${describeValue(tasksValue)}`,
    );
  }
  const tasks = tasksValue.map((entry, index) => {
    const task = expectObject(entry, `output task at index ${index}`);
    const id = readRequiredString(task, "id", `output task at index ${index}`);
    const stdout = readOptionalStreamOutput(task, "stdout", `output task at index ${index}`);
    const stderr = readOptionalStreamOutput(task, "stderr", `output task at index ${index}`);
    return { id, stdout, stderr };
  });

  return { generation, tasks };
}

/** Compact content projection used by tool content. */
export function formatWatcherOutput(result: WatcherOutputResult): string {
  if (result.tasks.length === 0) {
    return `OUTPUT gen=${result.generation} tasks=0`;
  }

  const blocks: string[] = [];
  for (const task of result.tasks) {
    const streams: Array<[WatcherOutputStream, WatcherStreamOutput]> = [];
    if (task.stdout !== null) streams.push(["stdout", task.stdout]);
    if (task.stderr !== null) streams.push(["stderr", task.stderr]);
    for (const [stream, output] of streams) {
      const flags = output.truncated ? " truncated" : "";
      const header = `OUTPUT gen=${result.generation} task=${task.id} stream=${stream} retained=${output.retainedBytes} observed=${output.observedBytes}${flags}`;
      if (output.content === "") {
        blocks.push(header);
        continue;
      }
      const indented = output.content
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      blocks.push(`${header}\n${indented}`);
    }
  }
  return blocks.join("\n");
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

function readRequiredString(object: Record<string, unknown>, field: string, what: string): string {
  if (!(field in object)) {
    throw new WatcherProtocolError(`Funzzy ${what}: "${field}" is required`);
  }
  const value = object[field];
  if (typeof value !== "string") {
    throw new WatcherProtocolError(
      `Funzzy ${what}: "${field}" must be a string, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readOptionalStreamOutput(
  object: Record<string, unknown>,
  field: string,
  what: string,
): WatcherStreamOutput | null {
  const value = object[field];
  if (value === null || value === undefined) return null;
  const stream = expectObject(value, `${what} "${field}"`);
  const content = readRequiredString(stream, "content", `${what} "${field}"`);
  const lines = readRequiredNumber(stream, "lines", `${what} "${field}"`);
  const retainedBytes = readRequiredNumber(stream, "retainedBytes", `${what} "${field}"`);
  const observedBytes = readRequiredNumber(stream, "observedBytes", `${what} "${field}"`);
  const truncated = readRequiredBoolean(stream, "truncated", `${what} "${field}"`);
  return { content, lines, retainedBytes, observedBytes, truncated };
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
