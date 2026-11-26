import { afterEach, describe, expect, it } from "vitest";
import { assertAgentRunSlotFree, HostRunOrderingRefused, HostRunSlotsFull } from "./run-slot-admission.js";

/** Each select() resolves with the next queued rows, whatever builder methods are chained on it. */
function fakeTx(results: unknown[][]) {
  const selects: number[] = [];
  const tx = {
    execute: async () => undefined,
    select: () => {
      selects.push(selects.length);
      const rows = results.shift() ?? [];
      const chain: Record<string, unknown> = new Proxy({}, {
        get: (_t, key) => key === "then" ? (resolve: (v: unknown) => void) => resolve(rows) : () => chain,
      });
      return chain;
    },
  };
  return { tx: tx as never, selects };
}

const run = { id: "run-2", companyId: "c", agentId: "a", retryOfRunId: null, contextSnapshot: null } as never;

describe("host run admission", () => {
  afterEach(() => { delete process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS; });

  it("refuses a non-head local run with the ordering reason, not the slots-full reason", async () => {
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "2";
    const { tx } = fakeTx([[{ driver: "local" }], [{ id: "run-1" }]]);
    const error = await assertAgentRunSlotFree(tx, run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRunOrderingRefused);
    expect(error).not.toBeInstanceOf(HostRunSlotsFull);
    expect((error as HostRunOrderingRefused).headRunId).toBe("run-1");
  });

  it("reports the real running count when the host is full", async () => {
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "2";
    const { tx } = fakeTx([[{ driver: null }], [{ id: "run-2" }], [{ count: 2 }]]);
    const error = await assertAgentRunSlotFree(tx, run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRunSlotsFull);
    expect(error).toMatchObject({ running: 2, limit: 2 });
  });

  it("skips host admission entirely for a run whose agent targets a remote environment", async () => {
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "1";
    // Only the environment lookup, then the per-agent count and limit; no host head or count queries.
    const { tx, selects } = fakeTx([[{ driver: "plugin" }], [{ count: 0 }], [{ limit: 5 }]]);
    await expect(assertAgentRunSlotFree(tx, run)).resolves.toBeUndefined();
    expect(selects).toHaveLength(3);
  });

  it("does not look up the environment when the host cap is off", async () => {
    const { tx, selects } = fakeTx([[{ count: 0 }], [{ limit: 5 }]]);
    await expect(assertAgentRunSlotFree(tx, run)).resolves.toBeUndefined();
    expect(selects).toHaveLength(2);
  });
});
