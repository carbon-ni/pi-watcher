/**
 * Shared strict decoders for the Funzzy control protocol.
 *
 * Every decoder reads from `unknown` and fails closed with an actionable
 * `WatcherProtocolError` instead of trusting a generic cast. Keep the field
 * readers here so `watcher.ts` (compatibility payloads) and `capabilities.ts`
 * (additive payloads) validate with one canonical implementation.
 */

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

export const EXECUTION_STATES = ["idle", "running", "passed", "failed", "cancelled"] as const;

export function expectObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WatcherProtocolError(
      `Funzzy ${what} must be a JSON object, got ${describeValue(value)}`,
    );
  }
  return value as Record<string, unknown>;
}

export function readRequiredNumber(
  object: Record<string, unknown>,
  field: string,
  what: string,
): number {
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

export function readNullableNumber(
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

export function readRequiredString(
  object: Record<string, unknown>,
  field: string,
  what: string,
): string {
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

export function readNullableString(
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

export function readRequiredBoolean(
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

export function readStringArray(
  object: Record<string, unknown>,
  field: string,
  what: string,
): string[] {
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

export function readExecutionState(
  object: Record<string, unknown>,
  what = "status response",
): (typeof EXECUTION_STATES)[number] {
  const value = object["state"];
  if (
    typeof value === "string" &&
    EXECUTION_STATES.includes(value as (typeof EXECUTION_STATES)[number])
  ) {
    return value as (typeof EXECUTION_STATES)[number];
  }
  throw new WatcherProtocolError(
    `Funzzy ${what}: "state" must be one of ${EXECUTION_STATES.join(", ")}, got ${describeValue(value)}`,
  );
}

export function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  if (typeof value === "object") return "an object";
  return "a non-JSON value";
}
