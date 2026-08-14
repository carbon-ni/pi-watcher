#!/usr/bin/env node
/**
 * Format check that produces a clear failure report.
 *
 * `prettier --check` only prints "[warn] <file>"; when the check runs inside a
 * larger gate (e.g. `make all` via Funzzy), an agent consuming the output can
 * miss which step failed and why. This script runs the same check and prints a
 * concise report: what failed, which files, and how to fix.
 */

import { execFileSync } from "node:child_process";

const ROOT = process.cwd();

function listDifferentFiles() {
  let out;
  try {
    out = execFileSync("prettier", ["--list-different", "."], {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch (error) {
    if (error.status === 1) {
      // prettier exits 1 when files differ: the list is in stdout.
      out = error.stdout ?? "";
    } else {
      const detail = error.stderr || error.stdout || error.message;
      console.error(`[format] FAILED — prettier errored (exit ${error.status})`);
      console.error(detail);
      process.exit(error.status ?? 1);
    }
  }
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const files = listDifferentFiles();

if (files.length === 0) {
  console.log("[format] OK — all files formatted.");
  process.exit(0);
}

console.log(`[format] FAILED — ${files.length} file(s) not formatted`);
console.log("");
console.log("Reason: prettier --check . (config: .prettierrc.json)");
console.log("Files:");
for (const file of files) {
  console.log(`  - ${file}`);
}
console.log("");
console.log("Fix: npm run format:write");

process.exit(1);
