import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface StoredDisconnectedSessions {
  v: 1;
  sessionIds: string[];
}

export async function disconnectSession(socketPath: string, sessionId: string): Promise<void> {
  requireSessionId(sessionId);
  const sessionIds = await readSessionIds(socketPath);
  if (sessionIds.includes(sessionId)) return;
  await writeSessionIds(socketPath, [...sessionIds, sessionId].sort());
}

export async function connectSession(socketPath: string, sessionId: string): Promise<void> {
  requireSessionId(sessionId);
  const sessionIds = await readSessionIds(socketPath);
  const remaining = sessionIds.filter((id) => id !== sessionId);
  if (remaining.length === sessionIds.length) return;

  if (remaining.length === 0) {
    await rm(disconnectedPath(socketPath), { force: true });
    return;
  }
  await writeSessionIds(socketPath, remaining);
}

export async function isSessionDisconnected(
  socketPath: string,
  sessionId: string,
): Promise<boolean> {
  const sessionIds = await readSessionIds(socketPath);
  return sessionIds.includes(sessionId);
}

function requireSessionId(sessionId: string): void {
  if (sessionId.trim().length === 0) throw new Error("Session ID must not be empty");
}

async function readSessionIds(socketPath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(disconnectedPath(socketPath), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const value = JSON.parse(raw) as Partial<StoredDisconnectedSessions>;
  if (!isStoredDisconnectedSessions(value)) {
    throw new Error(`Invalid Pi Funzzy disconnected state: ${disconnectedPath(socketPath)}`);
  }
  return value.sessionIds;
}

function isStoredDisconnectedSessions(
  value: Partial<StoredDisconnectedSessions>,
): value is StoredDisconnectedSessions {
  return (
    value.v === 1 &&
    Array.isArray(value.sessionIds) &&
    value.sessionIds.every((id) => typeof id === "string" && id.length > 0)
  );
}

async function writeSessionIds(socketPath: string, sessionIds: string[]): Promise<void> {
  const path = disconnectedPath(socketPath);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const state: StoredDisconnectedSessions = { v: 1, sessionIds };

  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function disconnectedPath(socketPath: string): string {
  return join(dirname(socketPath), ".pi-funzzy-disconnected.json");
}
