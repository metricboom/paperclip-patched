import { afterEach, describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";
import { clearLocalRunCpuControl, configureLocalRunCpuControl, readLocalRunCpuControl, takeLocalRunCpuAccounting } from "./local-run-cpu.js";

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
});
