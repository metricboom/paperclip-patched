import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real processes, real filesystem: acquirers take a lease and write session files into the
 * home while cleaners repeatedly detach and delete it. Unlike the hook-based tests, nothing
 * here is sequenced by the test. The invariant: a run holding a lease never loses its files.
 */
const CHILD = `
import fs from "node:fs/promises";
import path from "node:path";
import { acquireRunLease, detachHomeIfUnused } from "./home-lease.ts";
const [role, home, id, iterations] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let violations = 0, acquired = 0, removed = 0;
if (role === "run") {
  for (let i = 0; i < Number(iterations); i += 1) {
    const release = process.env.NAIVE === "1" ? await naiveAcquire(home) : await acquireRunLease(home);
    acquired += 1;
    await fs.mkdir(path.join(home, "sessions"), { recursive: true });
    const file = path.join(home, "sessions", id + "-" + i);
    await fs.writeFile(file, "session");
    await sleep(Math.random() * 4);
    const ok = await fs.access(file).then(() => true, () => false);
    if (!ok) violations += 1;
    await release();
  }
} else {
  const end = Date.now() + Number(iterations);
  const agentDir = path.dirname(home);
  while (Date.now() < end) {
    const tombs = await detachHomeIfUnused({ agentDir, home, targets: [home], now: Date.now(), isIdle: async () => true });
    for (const t of tombs ?? []) { await fs.rm(t, { recursive: true, force: true }); removed += 1; }
    await sleep(Math.random() * 2);
  }
}
async function naiveAcquire(home) {
  const dir = path.join(home, ".paperclip-run-leases");
  const file = path.join(dir, process.pid + "-" + Math.random() + ".json");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  return async () => { await fs.rm(file, { force: true }).catch(() => {}); };
}
console.log(JSON.stringify({ role, violations, acquired, removed }));
`;

function runChild(dir: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, "child.mjs"), ...args], { env: { ...process.env, ...env } });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("run leases against concurrent cleanup, in separate processes", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "home-lease-proc-"));
    // Node >= 24 runs the file as-is (it uses only node builtins and erasable types).
    await fs.copyFile(path.join(import.meta.dirname, "home-lease.ts"), path.join(dir, "home-lease.ts"));
    await fs.writeFile(path.join(dir, "child.mjs"), CHILD);
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function stress(env: Record<string, string>) {
    const agentDir = path.join(dir, `agent-${Math.random().toString(16).slice(2)}`);
    const home = path.join(agentDir, "c".repeat(64));
    await fs.mkdir(home, { recursive: true });
    const jobs = [
      ...[0, 1, 2, 3].map((n) => runChild(dir, ["run", home, `r${n}`, "60"], env)),
      ...[0, 1].map(() => runChild(dir, ["clean", home, "x", "2500"], env)),
    ];
    const results = await Promise.all(jobs);
    for (const r of results) expect(r.code, r.err).toBe(0);
    const parsed = results.map((r) => JSON.parse(r.out.trim()) as { role: string; violations: number; acquired: number; removed: number });
    return {
      violations: parsed.filter((p) => p.role === "run").reduce((n, p) => n + p.violations, 0),
      acquired: parsed.filter((p) => p.role === "run").reduce((n, p) => n + p.acquired, 0),
      removed: parsed.filter((p) => p.role === "clean").reduce((n, p) => n + p.removed, 0),
    };
  }

  it("never removes a home out from under a run that holds its lease", async () => {
    const outcome = await stress({});
    expect(outcome.acquired).toBe(240);
    expect(outcome.violations).toBe(0);
    expect(outcome.removed).toBeGreaterThan(0); // cleaners did get to delete the home between runs
  }, 60_000);
});
