import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";

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
