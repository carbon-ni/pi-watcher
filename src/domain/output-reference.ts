import { describeValue, expectObject, WatcherProtocolError } from "./protocol.js";
import type { WatcherLimits } from "./capabilities.js";

export type OutputReferenceMode = "tail" | "page";

export interface WatcherOutputReference {
  instanceToken: string;
  generation: number;
  task?: string;
  stream: "stdout" | "stderr" | null;
  mode: OutputReferenceMode;
  tail?: number;
  maxBytes: number;
}

/** Schema mismatch is terminal for this call; parameter retries are unsafe. */
export class OutputReferenceCompatibilityError extends Error {
  readonly doNotRetry = true;

  constructor(message: string) {
    super(message);
    this.name = "OutputReferenceCompatibilityError";
  }
}

export function ensureOutputReferenceCompatibility(
  limits: Pick<
    WatcherLimits,
    "outputSchemaVersion" | "outputModes" | "outputPageSizeMax" | "outputMaxBytesEffective"
  >,
): void {
  if (
    limits.outputSchemaVersion !== 2 ||
    limits.outputPageSizeMax === null ||
    limits.outputMaxBytesEffective === null ||
    !limits.outputModes.includes("tail")
  ) {
    throw new OutputReferenceCompatibilityError(
      "Funzzy output reference schema is incompatible; reload-extension or upgrade-funzzy (do not retry)",
    );
  }
}

export function decodeOutputReference(value: unknown): WatcherOutputReference {
  const object = expectObject(value, "output reference");
  const instanceToken = readNonEmptyString(object, "instanceToken");
  const generation = readPositiveSafeInteger(object, "generation");
  const task = readOptionalNonEmptyString(object, "task");
  const stream = readStream(object);
  const mode = readMode(object);
  const tail = mode === "tail" ? readPositiveSafeInteger(object, "tail") : undefined;
  const maxBytes = readPositiveSafeInteger(object, "maxBytes");
  if (maxBytes >= 65_536) {
    throw new WatcherProtocolError(
      `Funzzy output reference: "maxBytes" must stay below transport limit, got ${maxBytes}`,
    );
  }
  return {
    instanceToken,
    generation,
    ...(task === undefined ? {} : { task }),
    stream,
    mode,
    ...(tail === undefined ? {} : { tail }),
    maxBytes,
  };
}

function readNonEmptyString(object: Record<string, unknown>, field: string): string {
  const value = object[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new WatcherProtocolError(
      `Funzzy output reference: "${field}" must be a non-empty string, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readOptionalNonEmptyString(
  object: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!(field in object)) return undefined;
  return readNonEmptyString(object, field);
}

function readPositiveSafeInteger(object: Record<string, unknown>, field: string): number {
  const value = object[field];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new WatcherProtocolError(
      `Funzzy output reference: "${field}" must be a positive safe integer, got ${describeValue(value)}`,
    );
  }
  return value as number;
}

function readStream(object: Record<string, unknown>): "stdout" | "stderr" | null {
  const value = object["stream"];
  if (value === null || value === "stdout" || value === "stderr") return value;
  throw new WatcherProtocolError(`Funzzy output reference: "stream" is invalid`);
}

function readMode(object: Record<string, unknown>): OutputReferenceMode {
  const value = object["mode"];
  if (value === "tail" || value === "page") return value;
  throw new WatcherProtocolError(`Funzzy output reference: "mode" is invalid`);
}
