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
