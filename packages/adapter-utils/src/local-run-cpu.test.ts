import { afterEach, describe, expect, it, vi } from "vitest";
import { runChildProcess } from "./server-utils.js";
import { beginLocalRunCpuAccounting, clearLocalRunCpuControl, configureLocalRunCpuControl, containProcessGroupInCgroup, foldProcRowsIntoHighWater, isBenignProcWriteError, highWaterDeltaTotals, mergeLocalRunCpuAccounting, readLocalProcessStarttime, readLocalRunCpuControl, takeLocalRunCpuAccounting, verifyLocalProcessIdentity, type LocalRunCpuAccounting } from "./local-run-cpu.js";

describe("local run CPU controls", () => {
  afterEach(() => clearLocalRunCpuControl("cpu-fixture"));

  it("keeps controls disabled until a valid heartbeat setting is supplied", () => {
    expect(readLocalRunCpuControl({})).toBeNull();
    expect(readLocalRunCpuControl({ heartbeat: { cpuNice: 20, cpuQuotaPercent: 0 } })).toBeNull();
    expect(readLocalRunCpuControl({ heartbeat: { cpuNice: 10, cpuQuotaPercent: 25 } }))
      .toEqual({ nice: 10, quotaPercent: 25 });
  });

  it("records local process CPU and wall time without treating a fallback as a quota", async () => {
    configureLocalRunCpuControl("cpu-fixture", { nice: 10, quotaPercent: null });
    await runChildProcess("cpu-fixture", process.execPath, ["-e", "for (let i = 0; i < 2e6; i++) Math.sqrt(i)"], {
      cwd: process.cwd(), env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {},
    });
    const accounting = takeLocalRunCpuAccounting("cpu-fixture");
    expect(accounting).toMatchObject({ schema: "paperclip.local_run_cpu.v1", scope: "local_process_tree", quality: "approximate_proc_group" });
    expect(accounting?.wallSeconds).toBeGreaterThanOrEqual(0);
    expect(accounting?.control).toMatchObject({ method: "nice", quotaEnforced: false, appliedNice: 10 });
  });

  it("sums CPU across two child processes of one run instead of keeping only the last", async () => {
    const spin = ["-e", "const end = Date.now() + 300; while (Date.now() < end) Math.sqrt(1)"];
    const opts = { cwd: process.cwd(), env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {} };
    configureLocalRunCpuControl("cpu-fixture", { nice: 10, quotaPercent: null });
    await runChildProcess("cpu-fixture", process.execPath, spin, opts);
    const single = takeLocalRunCpuAccounting("cpu-fixture");
    await runChildProcess("cpu-fixture", process.execPath, spin, opts);
    await runChildProcess("cpu-fixture", process.execPath, spin, opts);
    const both = takeLocalRunCpuAccounting("cpu-fixture");
    expect(single?.cpuSeconds).toBeGreaterThan(0.1);
    expect(both?.cpuSeconds).toBeGreaterThan((single?.cpuSeconds ?? 0) * 1.5);
  });

  it("retains accounting only for runs registered through the dispatch path", async () => {
    // Synthetic callers (model discovery, one-off probes) never register, so their accounting is
    // returned to the direct caller but never retained for a consumer that does not exist. A
    // registered heartbeat run's entry is retained until taken, unaffected by discovery volume.
    for (let i = 0; i < 300; i += 1) {
      const finishDiscovery = await beginLocalRunCpuAccounting(`cpu-discovery-${i}`, process.pid, null);
      await finishDiscovery();
    }
    expect(takeLocalRunCpuAccounting("cpu-discovery-0")).toBeNull();
    expect(takeLocalRunCpuAccounting("cpu-discovery-299")).toBeNull();
    configureLocalRunCpuControl("cpu-registered", readLocalRunCpuControl({ heartbeat: { cpuNice: 10 } }));
    const finish = await beginLocalRunCpuAccounting("cpu-registered", process.pid, null);
    await finish();
    expect(takeLocalRunCpuAccounting("cpu-registered")).not.toBeNull();
    expect(takeLocalRunCpuAccounting("cpu-registered")).toBeNull();
  });

  it("samples the descendant tree when no process group exists (the ACP spawn shape)", async () => {
    if (process.platform !== "linux") return;
    const { spawn } = await import("node:child_process");
    // Not detached: the child shares this process's group, as an ACPX-spawned agent does.
    const child = spawn(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'const e = Date.now() + 900; while (Date.now() < e);'], { stdio: 'ignore' }); const e = Date.now() + 900; while (Date.now() < e);"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => child.on("spawn", resolve));
      const finish = await beginLocalRunCpuAccounting("cpu-tree", child.pid!, null);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const accounting = await finish();
      expect(accounting.cpuSeconds).toBeGreaterThan(0.1);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("verifies a process identity token before attaching to an unspawned pid", async () => {
    if (process.platform !== "linux") return;
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2_000)"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => child.on("spawn", resolve));
      // The trusted spawn path captures the kernel starttime while the child handle is live;
      // later attachment compares that exact value. A wrong token, a recycled pid, and an older
      // warm entry with no token at all must all fail the match.
      const token = await readLocalProcessStarttime(child.pid!);
      expect(token).not.toBeNull();
      expect(await verifyLocalProcessIdentity(child.pid!, token)).toBe(true);
      expect(await verifyLocalProcessIdentity(child.pid!, (token ?? 0) + 1)).toBe(false);
      expect(await verifyLocalProcessIdentity(child.pid!, null)).toBe(false);
      expect(await verifyLocalProcessIdentity(child.pid!, undefined)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("preserves CPU already observed for a descendant that exits before the run ends", async () => {
    if (process.platform !== "linux") return;
    const { spawn } = await import("node:child_process");
    // The child spawns a CPU-heavy grandchild that exits after ~900 ms, then idles past another
    // sampling interval. Without per-PID high-water accumulation the later samples no longer see
    // the exited grandchild and its observed CPU is discarded (the finding reported ~0.16 s for
    // this shape). With accumulation the observed work survives the exit.
    const child = spawn(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'const e = Date.now() + 900; while (Date.now() < e);'], { stdio: 'ignore' }); setTimeout(() => {}, 2_000);"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => child.on("spawn", resolve));
      const finish = await beginLocalRunCpuAccounting("cpu-exit", child.pid!, null);
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      const accounting = await finish();
      expect(accounting.cpuSeconds).toBeGreaterThan(0.4);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("treats a recycled pid as a distinct process and charges only post-baseline CPU", () => {
    // Deterministic identity-keying check: a warm process observed at begin (kernel starttime
    // 100) contributes only its post-baseline delta; when the pid is recycled (starttime 200)
    // the new process is a fresh identity whose observed work counts from zero, and the old
    // process's retained high-water is unaffected.
    const highWater = new Map<string, import("./local-run-cpu.js").HighWaterEntry>();
    const row = (pid: number, starttime: number, user: number, system: number) => ({ pid, starttime, user, system });
    foldProcRowsIntoHighWater(highWater, [row(7, 100, 50, 5)], true, 100);  // present at begin: baseline
    foldProcRowsIntoHighWater(highWater, [row(7, 100, 80, 9)], false, 100); // in-window work: +30/+4
    // Recycled pid: starttime 200 is at/after the window start, so it is a born-in-window
    // identity and its observed work counts from zero.
    expect(foldProcRowsIntoHighWater(highWater, [row(7, 200, 30, 2)], false, 100)).toBe(0);
    expect(highWaterDeltaTotals(highWater)).toEqual({ user: 60, system: 6 });
  });

  it("flags a pre-existing process entering the sampled set instead of charging its lifetime", () => {
    // First seen after begin does not prove born in-window. An identity whose kernel starttime
    // predates the window start (e.g. reparented into the tree) is baselined at first
    // observation: only its post-observation delta counts, the entrant is flagged, and its
    // earlier lifetime is never reported as measured run CPU.
    const highWater = new Map<string, import("./local-run-cpu.js").HighWaterEntry>();
    const row = (pid: number, starttime: number, user: number, system: number) => ({ pid, starttime, user, system });
    foldProcRowsIntoHighWater(highWater, [row(7, 5000, 10, 1)], true, 5000); // begin at tick 5000
    expect(foldProcRowsIntoHighWater(highWater, [row(9, 1000, 400, 40)], false, 5000)).toBe(1); // pre-existing entrant
    expect(foldProcRowsIntoHighWater(highWater, [row(9, 1000, 430, 44)], false, 5000)).toBe(0); // +30/+4 in-window
    expect(foldProcRowsIntoHighWater(highWater, [row(10, 5001, 20, 2)], false, 5000)).toBe(0);  // born in-window
    expect(highWaterDeltaTotals(highWater)).toEqual({ user: 50, system: 6 });
    // Boundary: one tick before the window start is already pre-existing, never "definitively new".
    expect(foldProcRowsIntoHighWater(highWater, [row(12, 4999, 700, 70)], false, 5000)).toBe(1);
    expect(foldProcRowsIntoHighWater(highWater, [row(12, 4999, 705, 71)], false, 5000)).toBe(0);
    expect(highWaterDeltaTotals(highWater)).toEqual({ user: 55, system: 7 });
    // Undecidable origin (no window reference) is also baselined and flagged, never assumed new.
    const blind = new Map<string, import("./local-run-cpu.js").HighWaterEntry>();
    expect(foldProcRowsIntoHighWater(blind, [row(11, 42, 90, 9)], false, null)).toBe(1);
    expect(highWaterDeltaTotals(blind)).toEqual({ user: 0, system: 0 });
  });

  it("contains an immediately-forking process group in the quota cgroup before it can escape", async () => {
    if (process.platform !== "linux") return;
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cpu-cgroup-"));
    const directory = path.join(root, "paperclip-runs", "cpu-cgroup");
    await fs.mkdir(directory, { recursive: true });
    // detached: the child leads its own process group, exactly as runChildProcess spawns it, and
    // it forks a grandchild during startup - the shape that used to escape a root-pid-only move.
    const child = spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' }); setTimeout(() => {}, 3000);"], { stdio: "ignore", detached: true });
    try {
      await new Promise((resolve) => child.on("spawn", resolve));
      await new Promise((resolve) => setTimeout(resolve, 150));
      await containProcessGroupInCgroup(directory, child.pid!, child.pid!);
      const moved = (await fs.readFile(path.join(directory, "cgroup.procs"), "utf8")).trim().split("\n").map(Number);
      expect(moved).toContain(child.pid!);
      expect(moved.length).toBeGreaterThanOrEqual(2); // the immediate grandchild was swept, not escaped
      // The group was resumed after containment (state is the field right after the comm close).
      const stat = await fs.readFile(`/proc/${child.pid}/stat`, "utf8");
      expect(stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[0]).not.toBe("T");
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
      child.kill("SIGKILL");
      const fs = await import("node:fs/promises");
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails containment on non-ESRCH cgroup.procs write errors instead of assuming an exited pid", async () => {
    if (process.platform !== "linux") return;
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    // Only ESRCH (the pid exited between scan and write) is benign; anything else - here a
    // permission-style failure simulated by a cgroup.procs that is a directory - must propagate
    // so the run falls back with a real reason instead of claiming containment.
    expect(isBenignProcWriteError(Object.assign(new Error("gone"), { code: "ESRCH" }))).toBe(true);
    expect(isBenignProcWriteError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isBenignProcWriteError(new Error("plain"))).toBe(false);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cpu-cgroup-eperm-"));
    try {
      const directory = path.join(root, "paperclip-runs", "cpu-eperm");
      await fs.mkdir(path.join(directory, "cgroup.procs"), { recursive: true });
      await expect(containProcessGroupInCgroup(directory, process.pid, null)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resumes the group and removes the cgroup directory when setup fails after containment", async () => {
    if (process.platform !== "linux") return;
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cpu-cgroup-fail-"));
    process.env.PAPERCLIP_CGROUP_ROOT = root;
    try {
      // A plain directory has no real cgroup cpu.stat, so setup fails after containment: the
      // group must be resumed, the directory removed, and the run must fall back without
      // claiming an enforced quota.
      configureLocalRunCpuControl("cpu-cgroup-fail", { nice: 10, quotaPercent: 50 });
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "ignore", detached: true });
      try {
        await new Promise((resolve) => child.on("spawn", resolve));
        const finish = await beginLocalRunCpuAccounting("cpu-cgroup-fail", child.pid!, child.pid!);
        const accounting = await finish();
        expect(accounting.control.quotaEnforced).toBe(false);
        expect(accounting.quality).toBe("approximate_proc_group");
        expect(accounting.control.fallbackReason).toContain("cpu.stat");
        await expect(fs.stat(path.join(root, "paperclip-runs", "cpu-cgroup-fail"))).rejects.toThrow();
        const stat = await fs.readFile(`/proc/${child.pid}/stat`, "utf8");
        expect(stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[0]).not.toBe("T");
      } finally {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
        child.kill("SIGKILL");
        clearLocalRunCpuControl("cpu-cgroup-fail");
      }
    } finally {
      delete process.env.PAPERCLIP_CGROUP_ROOT;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a live run's accounting across long multi-child spans and sweeps only unwound owners", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      configureLocalRunCpuControl("cpu-long", null);
      const finishFirst = await beginLocalRunCpuAccounting("cpu-long", process.pid, null);
      await finishFirst();
      configureLocalRunCpuControl("cpu-failed", null);
      const finishFailed = await beginLocalRunCpuAccounting("cpu-failed", process.pid, null);
      await finishFailed();
      clearLocalRunCpuControl("cpu-failed"); // dispatch unwound before result handling took the entry

      // Two hours later the long run is still dispatching: its early child's entry must survive.
      vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
      const finishSecond = await beginLocalRunCpuAccounting("cpu-long", process.pid, null);
      await finishSecond();

      expect(takeLocalRunCpuAccounting("cpu-failed")).toBeNull(); // abandoned owner, grace passed
      const longRun = takeLocalRunCpuAccounting("cpu-long");
      expect(longRun).toMatchObject({ schema: "paperclip.local_run_cpu.v1", scope: "local_process_tree" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mergeLocalRunCpuAccounting", () => {
  const record = (over: Partial<Omit<LocalRunCpuAccounting, "control">> & { control?: Partial<LocalRunCpuAccounting["control"]> }): LocalRunCpuAccounting => ({
    schema: "paperclip.local_run_cpu.v1", scope: "local_process_tree", quality: "exact_cgroup_v2",
    userCpuSeconds: 1, systemCpuSeconds: 0.5, cpuSeconds: 1.5, wallSeconds: 2,
    ...over,
    control: { requestedQuotaPercent: 50, requestedNice: null, method: "cgroup_v2", quotaEnforced: true, ...over.control },
  });

  it("returns the only record unchanged", () => {
    const only = record({});
    expect(mergeLocalRunCpuAccounting(null, only)).toBe(only);
  });

  it("adds CPU, takes the longest wall time, and downgrades quality and enforcement", () => {
    const merged = mergeLocalRunCpuAccounting(record({}), record({
      quality: "approximate_proc_group", userCpuSeconds: 2, systemCpuSeconds: null, cpuSeconds: 2, wallSeconds: 5,
      control: { method: "nice", quotaEnforced: false, fallbackReason: "no cgroup", appliedNice: 10 },
    }));
    expect(merged).toMatchObject({ quality: "approximate_proc_group", userCpuSeconds: 3, systemCpuSeconds: 0.5, cpuSeconds: 3.5, wallSeconds: 5 });
    expect(merged.control).toMatchObject({ method: "cgroup_v2", quotaEnforced: false, fallbackReason: "no cgroup", appliedNice: 10 });
  });

  it("keeps an unknown total unknown only when both sides are unknown", () => {
    const merged = mergeLocalRunCpuAccounting(record({ userCpuSeconds: null }), record({ userCpuSeconds: null }));
    expect(merged.userCpuSeconds).toBeNull();
  });
});
