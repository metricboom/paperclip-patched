import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimHome, claimPathFor } from "./home-lease.js";

/**
 * Fail-closed claim behavior. Claims are never stolen: a claim whose owner process is gone
 * stays in place and the home is skipped, so a stale observer that read a dead claim can
 * never rename away a live replacement claim.
 */
describe("claimHome dead-claim handling", () => {
  let agentDir: string;
  let home: string;
  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-lease-claim-"));
    home = path.join(agentDir, "c".repeat(64));
    await fs.mkdir(home, { recursive: true });
  });
  afterEach(async () => { await fs.rm(agentDir, { recursive: true, force: true }); });

  it("stale-observer regression: two observers of one dead claim can neither remove nor replace it", async () => {
    // Codex P1 (discussion_r4713859082): under claim stealing, two cleaners that both read
    // the same dead claim raced - the second renamed away the first's live replacement claim
    // and both ended up inside the protected section. Now neither may touch the claim.
    const claimPath = claimPathFor(home);
    const deadClaim = JSON.stringify({ pid: 2 ** 22 + 54321, startedAt: Date.now() });
    await fs.writeFile(claimPath, deadClaim);
    const [first, second] = await Promise.all([claimHome(home), claimHome(home)]);
    expect(first).toBeNull();
    expect(second).toBeNull();
    // The claim is untouched: still present, still owned by the dead pid, and no replacement
    // claim or staging file appeared beside it.
    await expect(fs.readFile(claimPath, "utf8")).resolves.toBe(deadClaim);
    const leftovers = (await fs.readdir(agentDir)).filter((name) => name.startsWith(".claim-") && name !== path.basename(claimPath));
    expect(leftovers).toEqual([]);
    // The dead claim still blocks a later attempt: nothing recovers it automatically.
    expect(await claimHome(home)).toBeNull();
    await expect(fs.readFile(claimPath, "utf8")).resolves.toBe(deadClaim);
  });

  it("still takes an uncontested claim and releases only it", async () => {
    const claim = await claimHome(home);
    expect(claim).not.toBeNull();
    await claim!.release();
    await expect(fs.access(claimPathFor(home))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
