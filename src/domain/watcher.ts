import { readOptionalDurationEstimate, type WatcherDurationEstimate } from "./duration-estimate.js";
import {
  type EXECUTION_STATES,
  describeValue,
  expectObject,
  readExecutionState,
  readNullableNumber,
  readNullableString,
  readRequiredNumber,
  readRequiredString,
  readStringArray,
  WatcherProtocolError,
} from "./protocol.js";

export { WatcherProtocolError } from "./protocol.js";

export type WatcherExecutionState = (typeof EXECUTION_STATES)[number];

export const WATCHER_SERVICE_STATES = [
  "starting",
  "ready",
  "restarting",
  "stopping",
  "failed",
  "stopped",
] as const;

export type WatcherServiceState = (typeof WATCHER_SERVICE_STATES)[number];

export interface WatcherManagedService {
  name: string;
  state: WatcherServiceState;
}

export interface WatcherTarget {
  name: string;
  commands: string[];
  /** Omitted when the server has no history or does not support estimates. */
  estimate?: WatcherDurationEstimate;
}

export interface WatcherStatus {
  generation: number;
  state: WatcherExecutionState;
  trigger: string | null;
  commands: string[];
  durationMs: number | null;
  failures: string[];
  /** Normalized to [] by decoders; optional for source-level legacy callers. */
  services?: WatcherManagedService[];
}

/**
 * Decode a `status` method result from `unknown`, validating every field.
 *
 * Wire shape is produced by the Rust control server (`src/control.rs`):
 * `ControlState` serialized with serde camelCase.
 */
export function decodeWatcherStatus(value: unknown, schemaVersion = 1): WatcherStatus {
  const object = expectObject(value, "status response");

  const generation = readRequiredNumber(object, "generation", "status response");
  const state = readExecutionState(object);
  const trigger = readNullableString(object, "trigger", "status response");
  const commands = readStringArray(object, "commands", "status response");
  const durationMs = readNullableNumber(object, "durationMs", "status response");
  const failures = readStringArray(object, "failures", "status response");
  const negotiatedSchema = readOptionalSchemaVersion(object) ?? schemaVersion;
  const services = readServices(object, negotiatedSchema >= 2, "status response");
  const normalizedServices = negotiatedSchema >= 2 || "services" in object ? { services } : {};

  return { generation, state, trigger, commands, durationMs, failures, ...normalizedServices };
}

function readOptionalSchemaVersion(object: Record<string, unknown>): number | null {
  if (!("schemaVersion" in object)) return null;
  const value = object["schemaVersion"];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new WatcherProtocolError(
      `Funzzy status response: "schemaVersion" must be a number, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readServices(
  object: Record<string, unknown>,
  required: boolean,
  what: string,
): WatcherManagedService[] {
  if (!("services" in object)) {
    if (required) throw new WatcherProtocolError(`Funzzy ${what}: "services" is required`);
    return [];
  }
  const value = object["services"];
  if (!Array.isArray(value)) {
    throw new WatcherProtocolError(
      `Funzzy ${what}: "services" must be an array, got ${describeValue(value)}`,
    );
  }
  return value.map((entry, index) => {
    const service = expectObject(entry, `${what} service at index ${index}`);
    const state = service["state"];
    if (
      typeof state !== "string" ||
      !WATCHER_SERVICE_STATES.includes(state as WatcherServiceState)
    ) {
      throw new WatcherProtocolError(
        `Funzzy ${what}: service "state" must be one of ${WATCHER_SERVICE_STATES.join(", ")}, got ${describeValue(state)}`,
      );
    }
    return {
      name: readRequiredString(service, "name", what),
      state: state as WatcherServiceState,
    };
  });
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
    const what = `target at index ${index}`;
    const name = readRequiredString(target, "name", what);
    const commands = readStringArray(target, "commands", what);
    const estimate = readOptionalDurationEstimate(target, what);
    return { name, commands, ...(estimate === null ? {} : { estimate }) };
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
