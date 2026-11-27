import { beforeEach, describe, expect, it, vi } from "vitest";

const signals = vi.hoisted(() => [] as Array<[string, string | undefined]>);
vi.mock("./delivery-work-notifications.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./delivery-work-notifications.js")>()),
  notifyDeliveryWork: async (_transaction: object, queue: string, hint?: string) => { signals.push([queue, hint]); },
}));

const { notifyAgentConfigurationDispatch, notifyHostRunSlotRelease, notifyRunDispatch } = await import("./run-dispatch-notifications.js");

const TASK_QUEUES = ["stranded-assignments", "assigned-work-invariant", "resolved-dependencies", "stale-issue-locks"];
const company = JSON.stringify({ companyId: "company-1" });

describe("run dispatch notifications", () => {
  beforeEach(() => { signals.length = 0; });

  it("wakes the company recovery and dispatch queues on an agent configuration write, but no task queue", async () => {
    await notifyAgentConfigurationDispatch({}, { companyId: "company-1" });
    expect(signals).toEqual([
      ["orphan-blockers", company], ["active-recovery-actions", company], ["task-watchdogs", company],
      ["native-process-sessions", company], ["execution-replacement", company], ["queued-run-dispatch", company],
    ]);
    expect(signals.filter(([queue]) => TASK_QUEUES.includes(queue))).toEqual([]);
  });

  it("wakes queued-run dispatch host-wide when a run holding a local host slot finishes", async () => {
    // The wildcard hint is what dispatch-work maps to a resume pass over every
    // company, so a host-cap waiter queued under another company is reached.
    const run = { runnerProfileJson: { hostRun: { hostId: "host-1", limit: 1, local: true } } };
    await expect(notifyHostRunSlotRelease({}, run)).resolves.toBe(true);
    expect(signals).toEqual([["queued-run-dispatch", "*"]]);
  });

  it("sends no wake when the finishing run held no local host slot", async () => {
    // Remote-target and cap-off completions free no host slot; waking every
    // company's queue for them would be unintended churn.
    await expect(notifyHostRunSlotRelease({}, { runnerProfileJson: { hostRun: { hostId: "host-1", limit: 1, local: false } } })).resolves.toBe(false);
    await expect(notifyHostRunSlotRelease({}, { runnerProfileJson: { adapterDispatch: { adapterType: "process" } } })).resolves.toBe(false);
    await expect(notifyHostRunSlotRelease({}, { runnerProfileJson: null })).resolves.toBe(false);
    expect(signals).toEqual([]);
  });

  it("still wakes every task queue with the company hint for a company run dispatch", async () => {
    await notifyRunDispatch({}, { companyId: "company-1" });
    for (const queue of TASK_QUEUES) expect(signals).toContainEqual([queue, JSON.stringify({ companyId: "company-1" })]);
    for (const queue of ["native-process-sessions", "execution-replacement", "queued-run-dispatch"]) {
      expect(signals).toContainEqual([queue, company]);
    }
  });
});
