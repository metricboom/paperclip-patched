import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Leases and claims that keep cleanup from deleting a generated Codex home a run is using.
 * Node builtins only, so a process-level test can load this file on its own.
 *
 * Protocol (both sides write their flag, then read the other's flag):
 *
 * - A run takes a lease: it writes its own file under `<home>/.paperclip-run-leases/`, then
 *   checks that no cleanup claim exists and that its lease file is still where it wrote it.
 *   If a claim exists, or the home was moved away, it removes its lease, waits, and retries.
 *   It returns only when its lease is in the live home and no cleanup holds the home.
 * - Cleanup takes a claim: a file `<agentDir>/.claim-<digest>` created atomically with its
 *   owner pid. It is a sibling of the home, so it is never inside what gets deleted. With the
 *   claim held, cleanup checks leases and activity, then moves the home aside with one rename
 *   and releases the claim. The recursive delete runs afterwards on the detached copy.
 *
 * Either cleanup sees the run's lease and backs off, or the run sees the claim and waits. A
 * run's lease is never inside a home that cleanup detaches. The claim is held only for a few
 * stat, readdir and rename calls, never for the delete.
 */

export const RUN_LEASE_FILE = ".paperclip-run-lease";
export const RUN_LEASES_DIR = ".paperclip-run-leases";
const HOUR_MS = 60 * 60 * 1000;
/** A lease older than this is treated as abandoned even if its pid is alive. */
export const MAX_LEASE_AGE_MS = 24 * HOUR_MS;
const CLAIM_WAIT_MS = 30_000;
const CLAIM_POLL_MS = 20;

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function claimPathFor(home: string): string {
  return path.join(path.dirname(home), `.claim-${path.basename(home)}`);
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

export async function homeHasLiveLease(home: string, now: number): Promise<boolean> {
  const legacy = await fs.readFile(path.join(home, RUN_LEASE_FILE), "utf8").catch(() => null);
  if (legacy !== null && leaseIsLive(legacy, now)) return true;
  const leaseDir = path.join(home, RUN_LEASES_DIR);
  for (const name of await fs.readdir(leaseDir).catch(() => [] as string[])) {
    const raw = await fs.readFile(path.join(leaseDir, name), "utf8").catch(() => null);
    if (raw !== null && leaseIsLive(raw, now)) return true;
  }
  return false;
}

type ClaimState = "none" | "live" | "dead";

async function readClaim(claimPath: string): Promise<ClaimState> {
  const raw = await fs.readFile(claimPath, "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : ""));
  if (raw === null) return "none";
  try {
    const owner = JSON.parse(raw) as { pid?: unknown };
    if (typeof owner.pid !== "number") return "live"; // unreadable: assume a cleaner is active
    return pidIsAlive(owner.pid) ? "live" : "dead";
  } catch {
    return "live";
  }
}

/** Remove a claim whose owner process is gone. The rename means only one stealer wins. */
async function stealDeadClaim(claimPath: string): Promise<void> {
  const aside = `${claimPath}.dead-${randomUUID()}`;
  if (await fs.rename(claimPath, aside).then(() => true, () => false)) await fs.rm(aside, { force: true }).catch(() => {});
}

/**
 * Mark `home` as in use by this process. Returns a release function that removes only this
 * lease. Call before the home is seeded. Throws if the lease cannot be established; never
 * returns a lease that sits in a home cleanup removed or is removing.
 */
export async function acquireRunLease(home: string, now = Date.now()): Promise<() => Promise<void>> {
  const leaseDir = path.join(home, RUN_LEASES_DIR);
  const leasePath = path.join(leaseDir, `${process.pid}-${randomUUID()}.json`);
  const claimPath = claimPathFor(home);
  const deadline = Date.now() + CLAIM_WAIT_MS;
  const release = async () => { await fs.rm(leasePath, { force: true }).catch(() => {}); };
  for (;;) {
    try {
      await fs.mkdir(leaseDir, { recursive: true });
      await fs.writeFile(leasePath, JSON.stringify({ pid: process.pid, startedAt: now }), { mode: 0o600 });
      const claim = await readClaim(claimPath);
      if (claim === "none") {
        // The lease must still be in the live home: a rename that landed between our write and
        // the claim check would have carried it into a detached copy.
        if (await fs.access(leasePath).then(() => true, () => false)) return release;
      } else if (claim === "dead") {
        await stealDeadClaim(claimPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await release();
        throw error;
      }
    }
    await release(); // step back so a cleanup in progress sees no lease from us
    if (Date.now() > deadline) throw new Error(`Timed out waiting for cleanup of ${path.basename(home)} to release its claim`);
    await sleep(CLAIM_POLL_MS);
  }
}

export type HomeClaim = { release: () => Promise<void> };

/** Take the cleanup claim for `home`, or return null when another live cleaner holds it. */
export async function claimHome(home: string): Promise<HomeClaim | null> {
  const claimPath = claimPathFor(home);
  const staging = `${claimPath}.new-${randomUUID()}`;
  await fs.writeFile(staging, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // link() is atomic and exclusive, and the claim appears with its owner already inside.
      const created = await fs.link(staging, claimPath).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false;
        throw error;
      });
      if (created) return { release: async () => { await fs.rm(claimPath, { force: true }).catch(() => {}); } };
      if ((await readClaim(claimPath)) !== "dead") return null;
      await stealDeadClaim(claimPath);
    }
    return null;
  } finally {
    await fs.rm(staging, { force: true }).catch(() => {});
  }
}

export const TOMB_PREFIX = ".removing-";

/**
 * Detach `home` (or the given paths inside it) from its path while holding the home's claim.
 * With the claim held no run can take a lease and be handed this home, so the lease and
 * idle checks are final. Nothing is ever moved back: what is detached has already passed
 * them. The caller deletes the returned detached copies. Returns null when the home is kept.
 */
export async function detachHomeIfUnused(input: {
  agentDir: string;
  home: string;
  targets: string[];
  now: number;
  isIdle: () => Promise<boolean>;
  afterClaim?: (home: string) => Promise<void>;
}): Promise<string[] | null> {
  const claim = await claimHome(input.home);
  if (!claim) return null; // another cleaner holds it
  const tombs: string[] = [];
  try {
    await input.afterClaim?.(input.home);
    if (await homeHasLiveLease(input.home, input.now)) return null;
    if (!(await input.isIdle())) return null;
    for (const target of input.targets) {
      const tomb = path.join(input.agentDir, `${TOMB_PREFIX}${randomUUID()}`);
      if (await fs.rename(target, tomb).then(() => true, () => false)) tombs.push(tomb);
    }
  } finally {
    await claim.release();
  }
  return tombs;
}
