import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type Exec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export function fingerprintParts(
  trackedPatch: string,
  untrackedFiles: Array<[string, Buffer]>,
): string {
  const hash = createHash("sha256");
  addPart(hash, "tracked", Buffer.from(trackedPatch));

  for (const [path, content] of [...untrackedFiles].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    addPart(hash, path, content);
  }

  return hash.digest("hex");
}

export async function worktreeFingerprint(cwd: string, exec: Exec): Promise<string> {
  const [diff, untracked] = await Promise.all([
    exec("git", ["diff", "--binary", "HEAD"], { cwd, timeout: 15_000 }),
    exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd, timeout: 15_000 }),
  ]);
  if (diff.code !== 0)
    throw new Error(`Failed to fingerprint tracked files: ${diff.stderr.trim()}`);
  if (untracked.code !== 0)
    throw new Error(`Failed to list untracked files: ${untracked.stderr.trim()}`);

  const paths = untracked.stdout.split("\0").filter(Boolean);
  const files = await Promise.all(
    paths.map(async (path): Promise<[string, Buffer]> => [
      path,
      await readFile(resolve(cwd, path)),
    ]),
  );
  return fingerprintParts(diff.stdout, files);
}

function addPart(hash: ReturnType<typeof createHash>, name: string, content: Buffer): void {
  hash.update(`${Buffer.byteLength(name)}:${name}:${content.length}:`);
  hash.update(content);
}
