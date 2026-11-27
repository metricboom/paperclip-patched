import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestCodexConfigForHomeIdentity, resolveManagedCodexHomeDir } from "./codex-home.js";
import { acquireRunLease, cleanupGeneratedCodexHomes } from "./managed-home-cleanup.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const COMPANY = "company-1";
const AGENT = "agent-1";
const digest = (n: number) => String(n).repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, "a");

describe("cleanupGeneratedCodexHomes", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let agentDir: string;
  const now = Date.now();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cleanup-"));
    env = { PAPERCLIP_HOME: root, PAPERCLIP_INSTANCE_ID: "test" };
    agentDir = path.join(resolveManagedCodexHomeDir(env, COMPANY), "skill-runtimes", AGENT);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  async function makeHome(name: string, ageMs: number, parent = agentDir) {
    const home = path.join(parent, name);
    for (const dir of ["plugins/cache", "cache", "sessions"]) {
      await fs.mkdir(path.join(home, dir), { recursive: true });
      await fs.writeFile(path.join(home, dir, "f"), "x");
    }
    await fs.writeFile(path.join(home, "state.sqlite"), "db");
    const when = new Date(now - ageMs);
    for (const entry of [home, ...(await fs.readdir(home)).map((e) => path.join(home, e))]) await fs.utimes(entry, when, when);
    return home;
  }
  const exists = (p: string) => fs.access(p).then(() => true, () => false);
  const run = (extra: Partial<Parameters<typeof cleanupGeneratedCodexHomes>[0]> = {}) =>
    cleanupGeneratedCodexHomes({ env, companyId: COMPANY, agentId: AGENT, now, ...extra });

  it("keeps the newest home untouched even when idle", async () => {
    const newest = await makeHome("a".repeat(64), 30 * DAY);
    const result = await run();
    expect(result.removedHomes).toEqual([]);
    expect(await exists(path.join(newest, "plugins"))).toBe(true);
  });

  it("keeps a home with a live lease", async () => {
    await makeHome("b".repeat(64), HOUR); // newer
    const live = await makeHome("c".repeat(64), 30 * DAY);
    await acquireRunLease(live, now);
    await run();
    expect(await exists(path.join(live, "plugins"))).toBe(true);
    expect(await exists(path.join(live, "sessions/f"))).toBe(true);
  });

  it("keeps a shared home protected until every overlapping run has released its lease", async () => {
    await makeHome("b".repeat(64), HOUR); // newer
    const shared = await makeHome("c".repeat(64), 30 * DAY);
    const releaseFirst = await acquireRunLease(shared, now);
    const releaseSecond = await acquireRunLease(shared, now);
    await releaseFirst();
    await run();
    expect(await exists(path.join(shared, "sessions/f"))).toBe(true);
    await releaseSecond();
    const idle = new Date(now - 30 * DAY);
    // Taking and releasing leases touches the home; age it again to model a later pass.
    await fs.utimes(path.join(shared, ".paperclip-run-leases"), idle, idle);
    await fs.utimes(shared, idle, idle);
    await run();
    expect(await exists(shared)).toBe(false);
  });

  it("makes a run that leases while cleanup holds the claim wait, then never strands its home", async () => {
    await makeHome("b".repeat(64), HOUR);
    const racing = await makeHome("c".repeat(64), 30 * DAY);
    let pending: Promise<() => Promise<void>> | null = null;
    let settledEarly = false;
    const result = await run({ hooks: { afterClaim: async (home) => {
      if (home !== racing) return;
      pending = acquireRunLease(racing, now);
      void pending.then(() => { settledEarly = true; }, () => {});
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settledEarly).toBe(false); // the run is held back while the claim is held
    } } });
    const release = await pending!;
    const leases = await fs.readdir(path.join(racing, ".paperclip-run-leases"));
    expect(leases).toHaveLength(1); // the lease sits in the live home, not in a detached copy
    expect(await fs.readdir(agentDir).then((names) => names.filter((n) => n.startsWith(".removing-")))).toEqual([]);
    if (result.removedHomes.length === 0) expect(await exists(path.join(racing, "sessions/f"))).toBe(true); // cleanup backed off: data intact
    await release();
  });

  it("backs off when a lease is already in place once the claim is held", async () => {
    await makeHome("b".repeat(64), HOUR);
    const racing = await makeHome("c".repeat(64), 30 * DAY);
    const result = await run({ hooks: { afterClaim: async (home) => { if (home === racing) await fs.mkdir(path.join(home, ".paperclip-run-leases"), { recursive: true }).then(() => fs.writeFile(path.join(home, ".paperclip-run-leases", "x.json"), JSON.stringify({ pid: process.pid, startedAt: now }))); } } });
    expect(result.removedHomes).toEqual([]);
    expect(await exists(path.join(racing, "sessions/f"))).toBe(true);
    expect(await exists(path.join(racing, "state.sqlite"))).toBe(true);
  });

  it("skips a home another live cleaner has claimed, and leaves a dead claim in place without recovering the home", async () => {
    await makeHome("b".repeat(64), HOUR);
    const target = await makeHome("c".repeat(64), 30 * DAY);
    const claimPath = path.join(agentDir, `.claim-${path.basename(target)}`);
    await fs.writeFile(claimPath, JSON.stringify({ pid: process.pid, startedAt: now }));
    expect((await run()).removedHomes).toEqual([]);
    expect(await exists(target)).toBe(true);
    // Fail closed: a claim whose owner died is never stolen or replaced; the home is skipped.
    const deadClaim = JSON.stringify({ pid: 2 ** 22 + 54321, startedAt: now });
    await fs.writeFile(claimPath, deadClaim);
    expect((await run()).removedHomes).toEqual([]);
    expect(await exists(target)).toBe(true);
    await expect(fs.readFile(claimPath, "utf8")).resolves.toBe(deadClaim);
  });

  it("only sweeps detached leftovers, never a live home, even a leased or recently active one", async () => {
    await makeHome("b".repeat(64), HOUR);
    const leased = await makeHome("c".repeat(64), 30 * DAY);
    await acquireRunLease(leased, now);
    const stale = path.join(agentDir, ".removing-old");
    await fs.mkdir(stale, { recursive: true });
    const old = new Date(now - 2 * HOUR);
    await fs.utimes(stale, old, old);
    await run();
    expect(await exists(stale)).toBe(false);
    expect(await exists(path.join(leased, "sessions/f"))).toBe(true);
  });

  it("does not remove a home that became active after the idle snapshot", async () => {
    await makeHome("b".repeat(64), HOUR);
    const racing = await makeHome("c".repeat(64), 30 * DAY);
    const result = await run({ hooks: { afterClaim: async (home) => { if (home === racing) { const t = new Date(now); await fs.utimes(path.join(racing, "state.sqlite"), t, t); } } } });
    expect(result.removedHomes).toEqual([]);
    expect(await exists(path.join(racing, "sessions/f"))).toBe(true);
  });

  it("ignores a lease whose process is gone", async () => {
    await makeHome("b".repeat(64), HOUR);
    const dead = await makeHome("c".repeat(64), 30 * DAY);
    await fs.writeFile(path.join(dead, ".paperclip-run-lease"), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: now }));
    // Writing the lease bumps the home's mtime; restore the idle age so the home is not "newest".
    const idle = new Date(now - 30 * DAY);
    await fs.utimes(path.join(dead, ".paperclip-run-lease"), idle, idle);
    await fs.utimes(dead, idle, idle);
    await run();
    expect(await exists(dead)).toBe(false);
  });

  it("prunes only rebuildable dirs of a moderately idle home", async () => {
    await makeHome("b".repeat(64), 0);
    const stale = await makeHome("c".repeat(64), 4 * HOUR);
    await run();
    expect(await exists(path.join(stale, "plugins"))).toBe(false);
    expect(await exists(path.join(stale, "cache"))).toBe(false);
    expect(await exists(path.join(stale, "sessions/f"))).toBe(true);
    expect(await exists(path.join(stale, "state.sqlite"))).toBe(true);
  });

  it("leaves recently used homes alone", async () => {
    await makeHome("b".repeat(64), 0);
    const recent = await makeHome("c".repeat(64), HOUR);
    const result = await run();
    expect(result.prunedRuntime).toEqual([]);
    expect(await exists(path.join(recent, "plugins"))).toBe(true);
  });

  it("removes a long-idle home entirely, but not the current one", async () => {
    await makeHome("b".repeat(64), 0);
    const old = await makeHome("c".repeat(64), 10 * DAY);
    const current = await makeHome("d".repeat(64), 10 * DAY);
    const result = await run({ currentHome: current });
    expect(await exists(old)).toBe(false);
    expect(await exists(current)).toBe(true);
    expect(result.removedHomes).toEqual([old]);
    expect(result.bytesFreedEstimate).toBeGreaterThan(0);
  });

  it("never touches paths outside the managed tree", async () => {
    await makeHome("b".repeat(64), 0);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codex-outside-"));
    try {
      const external = await makeHome("e".repeat(64), 30 * DAY, outside);
      // non-digest sibling, symlink to the outside home, and a traversal agent id
      await makeHome("not-a-digest", 30 * DAY);
      await fs.symlink(external, path.join(agentDir, "f".repeat(64)));
      await run();
      await cleanupGeneratedCodexHomes({ env, companyId: COMPANY, agentId: "../../..", now });
      expect(await exists(path.join(external, "plugins"))).toBe(true);
      expect(await exists(path.join(external, "sessions/f"))).toBe(true);
      expect(await exists(path.join(agentDir, "not-a-digest/plugins"))).toBe(true);
      expect((await fs.lstat(path.join(agentDir, "f".repeat(64)))).isSymbolicLink()).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("does not touch another agent's homes", async () => {
    await makeHome("b".repeat(64), 0);
    const other = await makeHome("c".repeat(64), 30 * DAY, path.join(path.dirname(agentDir), "agent-2"));
    await run();
    expect(await exists(path.join(other, "plugins"))).toBe(true);
  });
});

describe("digestCodexConfigForHomeIdentity", () => {
  const base = 'model = "gpt-5"\n\n[mcp_servers.x]\nurl = "https://x"\n';
  it("ignores Codex project trust entries and the managed MCP block", () => {
    const noisy = `${base}\n[projects."/tmp/run-1"]\ntrust_level = "trusted"\n\n# BEGIN PAPERCLIP MANAGED MCP\n[mcp_servers.pc]\nhttp_headers = { Authorization = "Bearer t1" }\n# END PAPERCLIP MANAGED MCP\n`;
    expect(digestCodexConfigForHomeIdentity(noisy)).toBe(digestCodexConfigForHomeIdentity(base));
  });
  it("still changes when an operator edits the config", () => {
    expect(digestCodexConfigForHomeIdentity(base.replace("gpt-5", "gpt-6"))).not.toBe(digestCodexConfigForHomeIdentity(base));
  });
});
