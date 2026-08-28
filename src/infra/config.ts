import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import type { WatcherConfigPresence } from "../domain/watcher-gate.js";

export interface FunzzyConfig {
  socketPath: string;
  pollIntervalMs: number;
}

export async function readConfig(cwd: string): Promise<FunzzyConfig | null> {
  for (const filename of [".watch.yaml", ".watch.yml"]) {
    const path = join(cwd, filename);
    const raw = await readOptionalFile(path);
    if (raw === null) continue;

    const parsed = parse(raw) as { on?: { socket?: unknown } } | null;
    const socketPath = parsed?.on?.socket;
    if (socketPath === undefined) return null;
    return validateConfig(cwd, path, socketPath);
  }

  return null;
}

function validateConfig(cwd: string, path: string, socketPath: unknown): FunzzyConfig {
  if (typeof socketPath !== "string" || socketPath.trim().length === 0) {
    throw new Error(`${path}: on.socket must be a non-empty string`);
  }

  return {
    socketPath: isAbsolute(socketPath) ? socketPath : resolve(cwd, socketPath),
    pollIntervalMs: 1_000,
  };
}

/** Existence-only adapter for the lazy-registration gate: never parses content. */
export async function readConfigPresence(cwd: string): Promise<WatcherConfigPresence> {
  const watchYaml = await fileExists(join(cwd, ".watch.yaml"));
  const watchYml = await fileExists(join(cwd, ".watch.yml"));
  return { watchYaml, watchYml };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
