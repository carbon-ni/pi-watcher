import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  decodeOutputReference,
  ensureOutputReferenceCompatibility,
  OutputReferenceCompatibilityError,
} from "./output-reference.js";

const reference = {
  instanceToken: "fz-18b4",
  generation: 42,
  task: "lint@ci",
  stream: null,
  mode: "tail",
  tail: 80,
  maxBytes: 48_000,
};

describe("output references", () => {
  it("decodes the canonical exact reference", () => {
    expect(decodeOutputReference(reference)).toEqual(reference);
  });

  it("decodes the mirrored Funzzy reference fixture", async () => {
    const raw = await readFile(
      join(import.meta.dirname, "fixtures", "output-reference.json"),
      "utf8",
    );
    expect(decodeOutputReference(JSON.parse(raw))).toMatchObject({
      instanceToken: "fz-7f3a",
      generation: 7,
      task: "lint @fast",
      tail: 80,
      maxBytes: 24_576,
    });
  });

  it.each([
    ["empty instance", { ...reference, instanceToken: "" }],
    ["unsafe generation", { ...reference, generation: Number.MAX_SAFE_INTEGER + 1 }],
    ["unknown mode", { ...reference, mode: "full" }],
    ["unsafe budget", { ...reference, maxBytes: 65_536 }],
  ])("rejects %s", (_label, malformed) => {
    expect(() => decodeOutputReference(malformed)).toThrow();
  });

  it("fails before RPC for legacy or incompatible schema", () => {
    expect(() =>
      ensureOutputReferenceCompatibility({
        outputSchemaVersion: null,
        outputModes: [],
        outputPageSizeMax: null,
        outputMaxBytesEffective: null,
      }),
    ).toThrow(OutputReferenceCompatibilityError);
    expect(() =>
      ensureOutputReferenceCompatibility({
        outputSchemaVersion: 3,
        outputModes: ["tail", "page"],
        outputPageSizeMax: 8192,
        outputMaxBytesEffective: 48_000,
      }),
    ).toThrow(/reload-extension|upgrade-funzzy/);
  });
});
