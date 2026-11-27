import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveManagedCodexHomeDir } from "./codex-home.js";
import { detachHomeIfUnused, homeHasLiveLease, TOMB_PREFIX } from "./home-lease.js";

export { acquireRunLease, RUN_LEASE_FILE, RUN_LEASES_DIR } from "./home-lease.js";

/**
 * Cleanup of generated per-run Codex homes
 * (`<codex-home>/{skill-runtimes,connector-runtimes}/<agentId>/<digest>/`).
 *
 * A new digest means a new home, and the Codex binary fills each one with
 * rebuildable runtime state (`plugins/`, `cache/`, ~60 MB). Nothing else
 * removes them, so we do it here in two tiers:
 *
 * 1. Idle homes lose only `plugins/` and `cache/`. The binary re-downloads them
 *    on demand; `sessions/`, `*.sqlite` and credentials stay, so resume works.
 * 2. Long-idle homes are removed whole. Codex resumes a session only from the
 *    home the run is launched with, and that home is chosen by digest. A home
 *    that has not been used for days belongs to a skill/config selection the
 *    agent has moved away from. If the digest ever recurs, the home is rebuilt
 *    and the adapter already falls back to a fresh session when resume fails.
 *
 * Never touched: a home with a live lease, an agent's newest home (per tree),
 * the home the current run uses, and anything outside the managed tree.
 */

export const GENERATED_HOME_TREES = ["skill-runtimes", "connector-runtimes"] as const;
const REBUILDABLE_DIRS = ["plugins", "cache"] as const;
const DIGEST_DIR_RE = /^[a-f0-9]{64}$/;
const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_PRUNE_RUNTIME_AFTER_MS = 3 * HOUR_MS;
export const DEFAULT_REMOVE_HOME_AFTER_MS = 7 * 24 * HOUR_MS;

export type GeneratedHomeCleanupResult = {
  prunedRuntime: string[];
  removedHomes: string[];
  bytesFreedEstimate: number;
};

/** Latest mtime among the home and its top-level entries (sqlite/session writes bump these). */
async function lastActivityMs(home: string): Promise<number> {
  let latest = (await fs.lstat(home)).mtimeMs;
  for (const name of await fs.readdir(home).catch(() => [] as string[])) {
    const stat = await fs.lstat(path.join(home, name)).catch(() => null);
    if (stat && stat.mtimeMs > latest) latest = stat.mtimeMs;
  }
  return latest;
}

async function treeSize(target: string): Promise<number> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of await fs.readdir(target).catch(() => [] as string[])) total += await treeSize(path.join(target, name));
  return total;
}

/** Delete detached copies and report the bytes freed. Safe at any time: they are off every path. */
async function removeTombs(tombs: string[]): Promise<number> {
  let bytes = 0;
  for (const tomb of tombs) {
    bytes += await treeSize(tomb);
    await fs.rm(tomb, { recursive: true, force: true });
  }
  return bytes;
}

export async function cleanupGeneratedCodexHomes(input: {
  env: NodeJS.ProcessEnv;
  companyId: string;
  agentId: string;
  /** The home the current run launched with; never touched. */
  currentHome?: string | null;
  now?: number;
  pruneRuntimeAfterMs?: number;
  removeHomeAfterMs?: number;
  /** Test seam: runs once the home's claim is held; not used in production. */
  hooks?: { afterClaim?: (home: string) => Promise<void> };
}): Promise<GeneratedHomeCleanupResult> {
  const now = input.now ?? Date.now();
  const pruneAfter = input.pruneRuntimeAfterMs ?? DEFAULT_PRUNE_RUNTIME_AFTER_MS;
  const removeAfter = input.removeHomeAfterMs ?? DEFAULT_REMOVE_HOME_AFTER_MS;
  const result: GeneratedHomeCleanupResult = { prunedRuntime: [], removedHomes: [], bytesFreedEstimate: 0 };
  // The agent id comes from the server, but never let it escape the tree.
  if (!input.agentId || input.agentId !== path.basename(input.agentId) || input.agentId === "." || input.agentId === "..") return result;
  const managedRoot = resolveManagedCodexHomeDir(input.env, input.companyId);
  const current = input.currentHome ? path.resolve(input.currentHome) : null;

  for (const tree of GENERATED_HOME_TREES) {
    const agentDir = path.join(managedRoot, tree, input.agentId);
    const names = await fs.readdir(agentDir).catch(() => [] as string[]);
    // Detached copies are off every path and already passed the lease and activity checks, so
    // leftovers from a cleaner that died before its delete can go. This never touches a live home.
    for (const name of names) {
      if (!name.startsWith(TOMB_PREFIX)) continue;
      const stale = await fs.lstat(path.join(agentDir, name)).catch(() => null);
      if (stale && now - stale.mtimeMs > HOUR_MS) await fs.rm(path.join(agentDir, name), { recursive: true, force: true }).catch(() => {});
    }
    const homes: Array<{ home: string; activity: number }> = [];
    for (const name of names) {
      if (!DIGEST_DIR_RE.test(name)) continue;
      const home = path.join(agentDir, name);
      const stat = await fs.lstat(home).catch(() => null);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
      homes.push({ home, activity: await lastActivityMs(home).catch(() => now) });
    }
    if (homes.length === 0) continue;
    homes.sort((a, b) => b.activity - a.activity);
    const newest = homes[0]!.home;
    for (const { home, activity } of homes) {
      if (home === newest || (current && path.resolve(home) === current)) continue;
      if (await homeHasLiveLease(home, now)) continue;
      const idle = now - activity;
      if (idle >= removeAfter) {
        const tombs = await detachHomeIfUnused({
          agentDir, home, targets: [home], now, afterClaim: input.hooks?.afterClaim,
          isIdle: async () => now - (await lastActivityMs(home).catch(() => now)) >= removeAfter,
        });
        if (tombs && tombs.length > 0) {
          result.bytesFreedEstimate += await removeTombs(tombs);
          result.removedHomes.push(home);
        }
        continue;
      }
      if (idle < pruneAfter) continue;
      const targets: string[] = [];
      for (const dir of REBUILDABLE_DIRS) {
        const target = path.join(home, dir);
        if (await fs.lstat(target).catch(() => null)) targets.push(target);
      }
      if (targets.length === 0) continue;
      const tombs = await detachHomeIfUnused({
        agentDir, home, targets, now, afterClaim: input.hooks?.afterClaim,
        isIdle: async () => now - (await lastActivityMs(home).catch(() => now)) >= pruneAfter,
      });
      if (tombs && tombs.length > 0) {
        result.bytesFreedEstimate += await removeTombs(tombs);
        result.prunedRuntime.push(...targets);
      }
    }
  }
  return result;
}
