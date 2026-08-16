import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Cross-session delivery ledger (contract §8): one atomic claim per failure
 * key, so concurrent Pi sessions sharing a watcher can prove at-most-once
 * delivery. The claim file is created exclusively (`wx`), so exactly one
 * claimant wins per key; a second claim for the same key is a safe no-op.
 * Old claims expire by age (documented policy) and are pruned opportunistically
 * by later claims.
 */

const DELIVERY_CLAIM_TTL_MS = 60 * 60_000;

export interface DeliveryClaim {
  v: 1;
  key: string;
  deliveredAt: number;
}

export async function claimFailureDelivery(socketPath: string, key: string): Promise<boolean> {
  const directory = dirname(socketPath);
  const path = join(directory, claimFileName(key));
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(
      path,
      `${JSON.stringify({ v: 1, key, deliveredAt: Date.now() } satisfies DeliveryClaim)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await pruneExpiredClaims(directory);
    return true;
  } catch (error) {
    if (isAlreadyExistsError(error)) return false;
    // Any other failure means exclusivity cannot be proven: fail closed and
    // never deliver (the failure stays undelivered rather than duplicated).
    return false;
  }
}

async function pruneExpiredClaims(directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(".pi-funzzy-delivered-") && entry.endsWith(".json"))
      .map(async (entry) => {
        try {
          const raw = await readFile(join(directory, entry), "utf8");
          const claim = JSON.parse(raw) as Partial<DeliveryClaim>;
          if (claim.v === 1 && typeof claim.deliveredAt === "number") {
            if (now - claim.deliveredAt > DELIVERY_CLAIM_TTL_MS) {
              await rm(join(directory, entry), { force: true });
            }
          }
        } catch {
          // Malformed or unreadable claims are left for the next successful claim.
        }
      }),
  );
}

function claimFileName(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9]/g, "-");
  return `.pi-funzzy-delivered-${safe}.json`;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
