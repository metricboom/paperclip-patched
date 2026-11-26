import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveManagedCodexHomeDir } from "./codex-home.js";

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
export const RUN_LEASE_FILE = ".paperclip-run-lease";
const REBUILDABLE_DIRS = ["plugins", "cache"] as const;
const DIGEST_DIR_RE = /^[a-f0-9]{64}$/;
const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_PRUNE_RUNTIME_AFTER_MS = 3 * HOUR_MS;
export const DEFAULT_REMOVE_HOME_AFTER_MS = 7 * 24 * HOUR_MS;
/** A lease older than this is treated as abandoned even if its pid is alive. */
const MAX_LEASE_AGE_MS = 24 * HOUR_MS;

export type GeneratedHomeCleanupResult = {
  prunedRuntime: string[];
  removedHomes: string[];
  bytesFreedEstimate: number;
};

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Each run owns its own lease file under `RUN_LEASES_DIR`, so two runs that share a
 * digest keep independent protection: one run finishing never removes the other's.
 * The single-file `RUN_LEASE_FILE` is still honored for homes leased by older code.
 */
export const RUN_LEASES_DIR = ".paperclip-run-leases";

/**
 * Mark `home` as in use by this process. Returns a release function that removes
 * only this lease. Call it before the home is seeded. If cleanup moves the home
 * away mid-acquire, the write fails and we retry against a freshly created home.
 */
export async function acquireRunLease(home: string, now = Date.now()): Promise<() => Promise<void>> {
  const leaseDir = path.join(home, RUN_LEASES_DIR);
  const leasePath = path.join(leaseDir, `${process.pid}-${randomUUID()}.json`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.mkdir(leaseDir, { recursive: true });
      await fs.writeFile(leasePath, JSON.stringify({ pid: process.pid, startedAt: now }), { mode: 0o600 });
      return async () => { await fs.rm(leasePath, { force: true }).catch(() => {}); };
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
    }
  }
  throw lastError;
}

function leaseIsLive(raw: string, now: number): boolean {
  try {
    const lease = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
    if (typeof lease.pid !== "number" || typeof lease.startedAt !== "number") return true; // unreadable: be safe
    return pidIsAlive(lease.pid) && now - lease.startedAt < MAX_LEASE_AGE_MS;
  } catch {
    return true; // corrupt lease: be safe
  }
}

async function homeHasLiveLease(home: string, now: number): Promise<boolean> {
  const legacy = await fs.readFile(path.join(home, RUN_LEASE_FILE), "utf8").catch(() => null);
  if (legacy !== null && leaseIsLive(legacy, now)) return true;
  const leaseDir = path.join(home, RUN_LEASES_DIR);
  for (const name of await fs.readdir(leaseDir).catch(() => [] as string[])) {
    const raw = await fs.readFile(path.join(leaseDir, name), "utf8").catch(() => null);
    if (raw !== null && leaseIsLive(raw, now)) return true;
  }
  return false;
}

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

/**
 * Move `target` aside atomically, re-check that nothing leased it in the meantime, then
 * delete it. Returns bytes freed, or null when the target was kept (restored or gone).
 * `leaseHome` is the home whose leases protect `target` (the target itself for a whole home).
 */
async function claimAndRemove(
  agentDir: string,
  target: string,
  now: number,
  stillIdleAfterMs: number | null,
  hooks: { beforeClaim?: (target: string) => Promise<void>; afterClaim?: (target: string) => Promise<void> } | undefined,
  size: (path: string) => Promise<number>,
  leaseHome: string = target,
): Promise<number | null> {
  await hooks?.beforeClaim?.(target);
  const tomb = path.join(agentDir, `.removing-${randomUUID()}`);
  try {
    await fs.rename(target, tomb);
  } catch {
    return null; // gone or not movable: leave it
  }
  await hooks?.afterClaim?.(target);
  // For a whole home the lease lives in the moved directory; for a runtime subdir it
  // lives in the home that stayed in place.
  const leased = leaseHome === target ? await homeHasLiveLease(tomb, now) : await homeHasLiveLease(leaseHome, now);
  const active = stillIdleAfterMs !== null && now - (await lastActivityMs(tomb).catch(() => now)) < stillIdleAfterMs;
  if (leased || active) {
    // Put it back unless a run already recreated the path; never overwrite.
    await fs.rename(tomb, target).catch(() => {});
    return null;
  }
  const bytes = await size(tomb);
  await fs.rm(tomb, { recursive: true, force: true });
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
  /** Test seams for the claim step; not used in production. */
  hooks?: { beforeClaim?: (target: string) => Promise<void>; afterClaim?: (target: string) => Promise<void> };
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
    // Sweep claim leftovers from a cleanup that died between rename and delete.
    for (const name of names) {
      if (!name.startsWith(".removing-")) continue;
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
        // Claim the home by renaming it, then re-check. A run that leased it before the
        // rename has its lease inside the moved directory, so the re-check sees it and we
        // put the home back. A run that leases after the rename recreates a fresh home.
        const freed = await claimAndRemove(agentDir, home, now, removeAfter, input.hooks, async (tomb) => (await treeSize(tomb)));
        if (freed !== null) {
          result.bytesFreedEstimate += freed;
          result.removedHomes.push(home);
        }
        continue;
      }
      if (idle < pruneAfter) continue;
      for (const dir of REBUILDABLE_DIRS) {
        const target = path.join(home, dir);
        const stat = await fs.lstat(target).catch(() => null);
        if (!stat) continue;
        const freed = await claimAndRemove(agentDir, target, now, null, input.hooks, treeSize, home);
        if (freed !== null) {
          result.bytesFreedEstimate += freed;
          result.prunedRuntime.push(target);
        }
      }
    }
  }
  return result;
}
