import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fleetInboxRoot } from "./paths.ts";

/**
 * Old agent sessions, compressed out of the way (routine `session-archive`).
 * Only an agent's current session is loaded, but old ones piled up on disk and
 * in every backup (kinwork-designer kept 155 MB of screenshot-heavy sessions;
 * measured 2026-10-22). Per agent: the newest KEEP_NEWEST sessions stay; any
 * other untouched for KEEP_DAYS is gzipped into sessions/archive/. Nothing is
 * deleted; `gunzip` brings one back.
 */
export const KEEP_NEWEST = 2;
export const KEEP_DAYS = 14;

export function archiveSessions(root = fleetInboxRoot(), now = Date.now()): { files: number; savedBytes: number; agents: string[] } {
  let files = 0;
  let savedBytes = 0;
  const agents = new Set<string>();
  for (const agent of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, agent, "sessions");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    const sessions = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const s of sessions.slice(KEEP_NEWEST)) {
      if (now - s.mtime < KEEP_DAYS * 86_400_000) continue;
      const data = readFileSync(s.path);
      const gz = Bun.gzipSync(data);
      mkdirSync(join(dir, "archive"), { recursive: true });
      writeFileSync(join(dir, "archive", `${s.f}.gz`), gz);
      unlinkSync(s.path);
      files++;
      savedBytes += data.length - gz.length;
      agents.add(agent);
    }
  }
  return { files, savedBytes, agents: [...agents] };
}
