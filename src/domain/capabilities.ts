import { readOptionalDurationEstimate, type WatcherDurationEstimate } from "./duration-estimate.js";
import {
  describeValue,
  expectObject,
  readExecutionState,
  readNullableNumber,
  readNullableString,
  readRequiredNumber,
  readRequiredString,
  readStringArray,
  WatcherProtocolError,
  type EXECUTION_STATES,
} from "./protocol.js";

export { WatcherProtocolError } from "./protocol.js";
export {
  WATCHER_SERVICE_STATES,
  type WatcherExecutionState,
  type WatcherManagedService,
  type WatcherServiceState,
} from "./watcher.js";

import type { WatcherStatus } from "./watcher.js";
import {
  WATCHER_SERVICE_STATES,
  type WatcherManagedService,
  type WatcherServiceState,
} from "./watcher.js";

/**
 * Correlated snapshot vocabulary (contract §1, §3):
 * an instance is one Funzzy process, a batch groups the tasks scheduled for
 * one trigger, and freshness tier labels how close a snapshot is to the
 * latest relevant truth. Decoders here are pure domain: no transport, no Pi.
 *
 * Compatibility path: servers without these additive payloads keep decoding
 * through `watcher.ts` (`status`, `targets`, `run`); negotiation maps them to
 * `LEGACY_CAPABILITY_PROFILE` instead of inventing correlation fields.
 */

export type WatcherFreshness = "current" | "stale" | "unknown";

export interface WatcherInstance {
  /** Opaque identity of one Funzzy watcher process; changes on restart. */
  token: string;
  /** Process start time when the server reports it, otherwise null. */
  startedAtEpochMs: number | null;
}

export interface WatcherLimits {
  /** Retained task output the server keeps before eviction. 0 = none. */
  outputRetentionBytes: number;
  /** Largest accepted control response. */
  maxResponseBytes: number;
  /** Default failure-evidence tail the server emits. */
  maxEvidenceLines: number;
  /** Advanced output retrieval contract; null fields mean legacy boolean-only support. */
  outputSchemaVersion: number | null;
  outputModes: string[];
  outputPageSizeMax: number | null;
  outputMaxBytesEffective: number | null;
}

export interface WatcherFeatures {
  atomicAwait: boolean;
  subscription: boolean;
  correlatedSnapshots: boolean;
  outputRetrieval: boolean;
  pendingWork: boolean;
  /** Historical target duration hints; false when absent or legacy. */
  durationEstimates: boolean;
  /** Exact-generation sequential override (TASK-0073); false when absent. */
  sequentialOverride: boolean;
  /** Optional for source-level callers constructing legacy profiles. */
  managedServices?: boolean;
}

export type WatcherCapabilitySource = "negotiated" | "legacy";

export interface WatcherCapabilityProfile {
  /** "legacy" labels weaker guarantees; never assume equivalence (contract §8). */
  source: WatcherCapabilitySource;
  protocolVersion: string;
  schemaVersion: number;
  instance: WatcherInstance;
  methods: string[];
  optionalFields: string[];
  limits: WatcherLimits;
  features: WatcherFeatures;
}

export const WATCHER_FRESHNESS_VALUES = ["current", "stale", "unknown"] as const;
export const WATCHER_TASK_STATES = ["passed", "failed", "cancelled", "timedout"] as const;

export type WatcherTaskState = (typeof WATCHER_TASK_STATES)[number];

export interface WatcherTaskOutcome {
  id: string;
  name: string;
  state: WatcherTaskState;
  durationMs: number | null;
}

/**
 * A status snapshot correlated to instance, batch, and task identities.
 * Superset of the compatibility `WatcherStatus` (contract §2).
 */
export interface WatcherCorrelatedSnapshot {
  instance: WatcherInstance;
  generation: number;
  batchId: string;
  state: (typeof EXECUTION_STATES)[number];
  trigger: string | null;
  commands: string[];
  tasks: WatcherTaskOutcome[];
  pending: number;
  freshness: WatcherFreshness;
  durationMs: number | null;
  failures: string[];
  /** Changed paths of the batch (optional; empty when unreported). */
  paths: string[];
  /** Live managed services, independent from generation outcome. */
  /** Normalized to [] by decoders; optional for source-level legacy callers. */
  services?: WatcherManagedService[];
  /** Configured scheduler concurrency of this watcher (TASK-0073). */
  configuredConcurrency: number;
  /** Effective concurrency of this generation (TASK-0073). */
  effectiveConcurrency: number;
  /** Override source label (TASK-0073): "config" or "control". */
  concurrencySource: string;
  /** Captured at generation start when the server has duration history. */
  estimate?: WatcherDurationEstimate;
}

/**
 * Explicit legacy profile for servers without a `capabilities` method
 * (contract §8): supported compatibility methods only, no features, no
 * instance identity. Produced by negotiation, never probed field by field.
 */
export const LEGACY_CAPABILITY_PROFILE: WatcherCapabilityProfile = {
  source: "legacy",
  protocolVersion: "1.0",
  schemaVersion: 1,
  instance: { token: "", startedAtEpochMs: null },
  limits: {
    outputRetentionBytes: 0,
    maxResponseBytes: 65_536,
    maxEvidenceLines: 40,
    outputSchemaVersion: null,
    outputModes: [],
    outputPageSizeMax: null,
    outputMaxBytesEffective: null,
  },
  methods: ["status", "targets", "run"],
  optionalFields: [],
  features: {
    atomicAwait: false,
    subscription: false,
    correlatedSnapshots: false,
    outputRetrieval: false,
    pendingWork: false,
    durationEstimates: false,
    sequentialOverride: false,
    managedServices: false,
  },
};

/**
 * Decode a `capabilities` method result from `unknown`.
 *
 * Wire shape is the agreed additive contract
 * (`src/domain/fixtures/capabilities.json`, mirrored by Rust protocol tests):
 * protocol/schema versions, one instance identity, supported methods,
 * optional correlation fields, output limits, and feature flags.
 */
export function decodeWatcherCapabilities(value: unknown): WatcherCapabilityProfile {
  const object = expectObject(value, "capabilities response");

  const protocolVersion = readRequiredString(object, "protocolVersion", "capabilities response");
  const schemaVersion = readRequiredNumber(object, "schemaVersion", "capabilities response");
  const instance = readWatcherInstance(object, "capabilities response");
  const methods = readStringArray(object, "methods", "capabilities response");
  const optionalFields = readOptionalStringArray(object, "optionalFields", "capabilities response");
  const limits = readWatcherLimits(object);
  const features = readWatcherFeatures(object);

  return {
    source: "negotiated",
    protocolVersion,
    schemaVersion,
    instance,
    methods,
    optionalFields,
    limits,
    features,
  };
}

/**
 * Decode a correlated snapshot result from `unknown`.
 *
 * Wire shape is the agreed additive contract
 * (`src/domain/fixtures/correlated-snapshot.json`): instance + batch identity,
 * generation, terminal or transitional state, per-task outcomes, pending work,
 * and the freshness tier.
 */
export function decodeWatcherCorrelatedSnapshot(
  value: unknown,
  schemaVersion = 1,
): WatcherCorrelatedSnapshot {
  const object = expectObject(value, "correlated snapshot");

  const instance = readWatcherInstance(object, "correlated snapshot");
  const generation = readRequiredNumber(object, "generation", "correlated snapshot");
  const batchId = readRequiredString(object, "batchId", "correlated snapshot");
  const state = readExecutionState(object, "correlated snapshot");
  const trigger = readOptionalNullableString(object, "trigger");
  const commands = readOptionalStringArray(object, "commands", "correlated snapshot");
  const tasks = readTaskOutcomes(object);
  const pending = readRequiredNumber(object, "pending", "correlated snapshot");
  const freshness = readFreshness(object);
  const durationMs = readOptionalNullableNumber(object, "durationMs");
  const failures = readOptionalStringArray(object, "failures", "correlated snapshot");
  const paths = readOptionalStringArray(object, "paths", "correlated snapshot");
  // Additive concurrency facts (TASK-0073): absent on legacy servers, so
  // default to configured == effective == 1 with the "config" source.
  const configuredConcurrency = readOptionalNullableNumber(object, "configuredConcurrency") ?? 1;
  const effectiveConcurrency = readOptionalNullableNumber(object, "effectiveConcurrency") ?? 1;
  const concurrencySource = readOptionalNullableString(object, "concurrencySource") ?? "config";
  const estimate = readOptionalDurationEstimate(object, "correlated snapshot");
  const services = readManagedServices(object, schemaVersion >= 2, "correlated snapshot");

  return {
    instance,
    generation,
    batchId,
    state,
    trigger,
    commands,
    tasks,
    services,
    pending,
    freshness,
    durationMs,
    failures,
    paths,
    configuredConcurrency,
    effectiveConcurrency,
    concurrencySource,
    ...(estimate === null ? {} : { estimate }),
  };
}

/** Policy entry point: whether a negotiated profile supports a method. */
export function hasMethod(profile: WatcherCapabilityProfile, method: string): boolean {
  return profile.methods.includes(method);
}

/**
 * Project a correlated snapshot onto the compatibility `WatcherStatus` shape
 * so footer and failure consumers can read one normalized status.
 */
export function snapshotToStatus(snapshot: WatcherCorrelatedSnapshot): WatcherStatus {
  return {
    generation: snapshot.generation,
    state: snapshot.state,
    trigger: snapshot.trigger,
    commands: snapshot.commands,
    durationMs: snapshot.durationMs,
    failures: snapshot.failures,
    services: snapshot.services ?? [],
  };
}

function readManagedServices(
  object: Record<string, unknown>,
  required: boolean,
  what: string,
): WatcherManagedService[] {
  if (!("services" in object)) {
    if (required) throw new WatcherProtocolError(`Funzzy ${what}: "services" is required`);
    return [];
  }
  const raw = object["services"];
  if (!Array.isArray(raw)) {
    throw new WatcherProtocolError(
      `Funzzy ${what}: "services" must be an array, got ${describeValue(raw)}`,
    );
  }
  return raw.map((value, index) => {
    const service = expectObject(value, `${what} service at index ${index}`);
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
      instanceId: readRequiredNumber(service, "instanceId", what),
      state: state as WatcherServiceState,
      originGeneration: readNullableNumber(service, "originGeneration", what),
      revision: readRequiredNumber(service, "revision", what),
      signature: readRequiredString(service, "signature", what),
      restartAttemptsUsed: readRequiredNumber(service, "restartAttemptsUsed", what),
      restartAttemptsRemaining: readRequiredNumber(service, "restartAttemptsRemaining", what),
      startedAtEpochMs: readNullableNumber(service, "startedAtEpochMs", what),
      readyAtEpochMs: readNullableNumber(service, "readyAtEpochMs", what),
      uptimeMs: readNullableNumber(service, "uptimeMs", what),
      latestError: readNullableString(service, "latestError", what),
    };
  });
}

function readWatcherInstance(object: Record<string, unknown>, what: string): WatcherInstance {
  const raw = object["instance"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WatcherProtocolError(
      `Funzzy ${what}: "instance" must be an object, got ${describeValue(raw)}`,
    );
  }
  const instance = raw as Record<string, unknown>;
  const token = readRequiredString(instance, "token", what);
  let startedAtEpochMs: number | null = null;
  if ("startedAtEpochMs" in instance) {
    const value = instance["startedAtEpochMs"];
    if (value !== null && (typeof value !== "number" || Number.isNaN(value))) {
      throw new WatcherProtocolError(
        `Funzzy ${what}: "startedAtEpochMs" must be a number or null, got ${describeValue(value)}`,
      );
    }
    startedAtEpochMs = value;
  }
  return { token, startedAtEpochMs };
}

function readOptionalStringArray(
  object: Record<string, unknown>,
  field: string,
  what: string,
): string[] {
  if (!(field in object)) return [];
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

function readWatcherLimits(object: Record<string, unknown>): WatcherLimits {
  if (!("limits" in object)) {
    return {
      outputRetentionBytes: 0,
      maxResponseBytes: LEGACY_CAPABILITY_PROFILE.limits.maxResponseBytes,
      maxEvidenceLines: LEGACY_CAPABILITY_PROFILE.limits.maxEvidenceLines,
      outputSchemaVersion: null,
      outputModes: [],
      outputPageSizeMax: null,
      outputMaxBytesEffective: null,
    };
  }
  const raw = object["limits"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WatcherProtocolError(
      `Funzzy capabilities response: "limits" must be an object, got ${describeValue(raw)}`,
    );
  }
  const limits = raw as Record<string, unknown>;
  return {
    outputRetentionBytes: readRequiredNumber(
      limits,
      "outputRetentionBytes",
      "capabilities response",
    ),
    maxResponseBytes: readRequiredNumber(limits, "maxResponseBytes", "capabilities response"),
    maxEvidenceLines: readRequiredNumber(limits, "maxEvidenceLines", "capabilities response"),
    outputSchemaVersion: readOptionalSafeInteger(limits, "outputSchemaVersion"),
    outputModes: readOptionalStringArray(limits, "outputModes", "capabilities response"),
    outputPageSizeMax: readOptionalSafeInteger(limits, "outputPageSizeMax"),
    outputMaxBytesEffective: readOptionalSafeInteger(limits, "outputMaxBytesEffective"),
  };
}

function readOptionalSafeInteger(object: Record<string, unknown>, field: string): number | null {
  if (!(field in object)) return null;
  const value = object[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WatcherProtocolError(
      `Funzzy capabilities response: "${field}" must be a non-negative safe integer, got ${describeValue(value)}`,
    );
  }
  return value as number;
}

function readWatcherFeatures(object: Record<string, unknown>): WatcherFeatures {
  if (!("features" in object)) {
    return { ...LEGACY_CAPABILITY_PROFILE.features };
  }
  const raw = object["features"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WatcherProtocolError(
      `Funzzy capabilities response: "features" must be an object, got ${describeValue(raw)}`,
    );
  }
  const features = raw as Record<string, unknown>;
  return {
    atomicAwait: readFeatureFlag(features, "features.atomicAwait"),
    subscription: readFeatureFlag(features, "features.subscription"),
    correlatedSnapshots: readFeatureFlag(features, "features.correlatedSnapshots"),
    outputRetrieval: readFeatureFlag(features, "features.outputRetrieval"),
    pendingWork: readFeatureFlag(features, "features.pendingWork"),
    // Additive: absent on older negotiated servers, never assumed.
    durationEstimates: readOptionalFeatureFlag(features, "features.durationEstimates"),
    // Additive (TASK-0073): absent on legacy servers, never assumed.
    sequentialOverride: readOptionalFeatureFlag(features, "features.sequentialOverride"),
    managedServices: readOptionalFeatureFlag(features, "features.managedServices"),
  };
}

function readFeatureFlag(object: Record<string, unknown>, field: string): boolean {
  const key = field.split(".").at(-1) ?? field;
  if (!(key in object)) {
    throw new WatcherProtocolError(`Funzzy capabilities response: "${field}" is required`);
  }
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new WatcherProtocolError(
      `Funzzy capabilities response: "${field}" must be a boolean, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readOptionalFeatureFlag(object: Record<string, unknown>, field: string): boolean {
  const key = field.split(".").at(-1) ?? field;
  if (!(key in object)) return false;
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new WatcherProtocolError(
      `Funzzy capabilities response: "${field}" must be a boolean, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readOptionalNullableString(object: Record<string, unknown>, field: string): string | null {
  if (!(field in object)) return null;
  const value = object[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new WatcherProtocolError(
      `Funzzy correlated snapshot: "${field}" must be a string or null, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readOptionalNullableNumber(object: Record<string, unknown>, field: string): number | null {
  if (!(field in object)) return null;
  const value = object[field];
  if (value === null) return null;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new WatcherProtocolError(
      `Funzzy correlated snapshot: "${field}" must be a number or null, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readTaskOutcomes(object: Record<string, unknown>): WatcherTaskOutcome[] {
  const field = "tasks";
  if (!(field in object)) {
    throw new WatcherProtocolError(`Funzzy correlated snapshot: "${field}" is required`);
  }
  const value = object[field];
  if (!Array.isArray(value)) {
    throw new WatcherProtocolError(
      `Funzzy correlated snapshot: "${field}" must be an array of objects, got ${describeValue(value)}`,
    );
  }
  return value.map((entry, index) => {
    const task = expectObject(entry, `task at index ${index}`);
    const id = readRequiredString(task, "id", `task at index ${index}`);
    const name = readRequiredString(task, "name", `task at index ${index}`);
    const state = readTaskState(task, index);
    const durationMs = readNullableNumber(task, "durationMs", `task at index ${index}`);
    return { id, name, state, durationMs };
  });
}

function readTaskState(object: Record<string, unknown>, index: number): WatcherTaskState {
  const value = object["state"];
  if (typeof value === "string" && WATCHER_TASK_STATES.includes(value as WatcherTaskState)) {
    return value as WatcherTaskState;
  }
  throw new WatcherProtocolError(
    `Funzzy task at index ${index}: "state" must be one of ${WATCHER_TASK_STATES.join(", ")}, got ${describeValue(value)}`,
  );
}

function readFreshness(object: Record<string, unknown>): WatcherFreshness {
  const value = object["freshness"];
  if (typeof value === "string" && WATCHER_FRESHNESS_VALUES.includes(value as WatcherFreshness)) {
    return value as WatcherFreshness;
  }
  throw new WatcherProtocolError(
    `Funzzy correlated snapshot: "freshness" must be one of ${WATCHER_FRESHNESS_VALUES.join(", ")}, got ${describeValue(value)}`,
  );
}
