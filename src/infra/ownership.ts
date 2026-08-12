import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface StoredResponder {
  v: 1;
  sessionId: string;
  updatedAt: number;
}

export interface Responder {
  mode: "automatic" | "pinned";
  sessionId: string;
}

export async function recordAutomaticResponder(
  socketPath: string,
  sessionId: string,
): Promise<void> {
  await writeResponder(automaticPath(socketPath), sessionId);
}

export async function setPinnedResponder(socketPath: string, sessionId: string): Promise<void> {
  await writeResponder(pinnedPath(socketPath), sessionId);
}

export async function clearPinnedResponder(socketPath: string): Promise<void> {
  await rm(pinnedPath(socketPath), { force: true });
}

export async function readResponder(socketPath: string): Promise<Responder | null> {
  const pinned = await readStoredResponder(pinnedPath(socketPath));
  if (pinned) return { mode: "pinned", sessionId: pinned.sessionId };

  const automatic = await readStoredResponder(automaticPath(socketPath));
  if (!automatic) return null;
  return { mode: "automatic", sessionId: automatic.sessionId };
}

async function writeResponder(path: string, sessionId: string): Promise<void> {
  if (sessionId.trim().length === 0) throw new Error("Responder session ID must not be empty");

  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const responder: StoredResponder = { v: 1, sessionId, updatedAt: Date.now() };

  try {
    await writeFile(temporaryPath, `${JSON.stringify(responder)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readStoredResponder(path: string): Promise<StoredResponder | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  const value = JSON.parse(raw) as Partial<StoredResponder>;
  if (value.v !== 1 || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error(`Invalid Pi Funzzy responder state: ${path}`);
  }
  return value as StoredResponder;
}

function automaticPath(socketPath: string): string {
  return join(dirname(socketPath), ".pi-funzzy-automatic-responder.json");
}

function pinnedPath(socketPath: string): string {
  return join(dirname(socketPath), ".pi-funzzy-pinned-responder.json");
}
