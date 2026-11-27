import { afterEach, describe, expect, it, vi } from "vitest";
import { runChildProcess } from "./server-utils.js";
import { beginLocalRunCpuAccounting, clearLocalRunCpuControl, configureLocalRunCpuControl, mergeLocalRunCpuAccounting, readLocalRunCpuControl, takeLocalRunCpuAccounting, type LocalRunCpuAccounting } from "./local-run-cpu.js";

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
