export type WatcherExecutionState = "idle" | "running" | "passed" | "failed" | "cancelled";

export interface WatcherTarget {
  name: string;
  commands: string[];
}

export interface WatcherStatus {
  generation: number;
  state: WatcherExecutionState;
  trigger: string | null;
  commands: string[];
  durationMs: number | null;
  failures: string[];
}

const EXECUTION_STATES: readonly WatcherExecutionState[] = [
  "idle",
  "running",
  "passed",
  "failed",
  "cancelled",
];

/**
 * Raised when a control-socket payload does not match the Funzzy protocol.
 * The message names the offending field and the expected shape so clients can
 * report the mismatch instead of trusting a generic cast.
 */
export class WatcherProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatcherProtocolError";
  }
}

/**
 * Decode a `status` method result from `unknown`, validating every field.
 *
 * Wire shape is produced by the Rust control server (`src/control.rs`):
 * `ControlState` serialized with serde camelCase.
 */
export function decodeWatcherStatus(value: unknown): WatcherStatus {
  const object = expectObject(value, "status response");

  const generation = readRequiredNumber(object, "generation", "status response");
  const state = readExecutionState(object);
  const trigger = readNullableString(object, "trigger", "status response");
  const commands = readStringArray(object, "commands", "status response");
  const durationMs = readNullableNumber(object, "durationMs", "status response");
  const failures = readStringArray(object, "failures", "status response");

  return { generation, state, trigger, commands, durationMs, failures };
}

/**
 * Decode a `targets` method result from `unknown`.
 *
 * Wire shape is produced by the Rust control server (`src/control.rs`):
 * a list of `ControlTarget { name, commands }`.
 */
export function decodeWatcherTargets(value: unknown): WatcherTarget[] {
  if (!Array.isArray(value)) {
    throw new WatcherProtocolError(
      `Funzzy targets response must be an array, got ${describeValue(value)}`,
    );
  }

  return value.map((entry, index) => {
    const target = expectObject(entry, `target at index ${index}`);
    const name = readRequiredString(target, "name", `target at index ${index}`);
    const commands = readStringArray(target, "commands", `target at index ${index}`);
    return { name, commands };
  });
}

/**
 * Decode a `run` method result from `unknown` into the scheduled generation.
 *
 * Wire shape is produced by the Rust control server (`src/control.rs`):
 * `{ "runId": <generation> }`.
 */
export function decodeWatcherRun(value: unknown): number {
  const object = expectObject(value, "run response");
  return readRequiredNumber(object, "runId", "run response");
}

function expectObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WatcherProtocolError(
      `Funzzy ${what} must be a JSON object, got ${describeValue(value)}`,
    );
  }
  return value as Record<string, unknown>;
}

function readRequiredNumber(object: Record<string, unknown>, field: string, what: string): number {
  if (!(field in object)) {
    throw new WatcherProtocolError(`Funzzy ${what}: "${field}" is required`);
  }
  const value = object[field];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new WatcherProtocolError(
      `Funzzy ${what}: "${field}" must be a number, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readNullableNumber(
  object: Record<string, unknown>,
  field: string,
  what: string,
): number | null {
  if (!(field in object)) {
    throw new WatcherProtocolError(`Funzzy ${what}: "${field}" is required`);
  }
  const value = object[field];
  if (value === null) return null;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new WatcherProtocolError(
      `Funzzy ${what}: "${field}" must be a number or null, got ${describeValue(value)}`,
    );
  }
  return value;
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

function readStringArray(object: Record<string, unknown>, field: string, what: string): string[] {
  if (!(field in object)) {
    throw new WatcherProtocolError(`Funzzy ${what}: "${field}" is required`);
  }
  const value = object[field];
  if (!Array.isArray(value)) {
    throw new WatcherProtocolError(
      `Funzzy ${what}: "${field}" must be an array of strings, got ${describeValue(value)}`,
    );
  }
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new WatcherProtocolError(
        `Funzzy ${what}: "${field}" must be an array of strings, got ${describeValue(value)}`,
      );
    }
    strings.push(entry);
  }
  return strings;
}

function readExecutionState(object: Record<string, unknown>): WatcherExecutionState {
  const value = object["state"];
  if (typeof value === "string" && EXECUTION_STATES.includes(value as WatcherExecutionState)) {
    return value as WatcherExecutionState;
  }
  throw new WatcherProtocolError(
    `Funzzy status response: "state" must be one of ${EXECUTION_STATES.join(", ")}, got ${describeValue(value)}`,
  );
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  if (typeof value === "object") return "an object";
  return "a non-JSON value";
}
