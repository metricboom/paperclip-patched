import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../../middleware/logger.js", () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { assertAgentRunSlotFree, HostRunOrderingRefused, HostRunSlotsFull, hostRunProfileFor, resolveHostRunLocality } from "./run-slot-admission.js";

/** Each select() resolves with the next queued rows, whatever builder methods are chained on it. */
function fakeTx(results: unknown[][]) {
  let selects = 0;
  const tx = {
    execute: async () => undefined,
    select: () => {
      selects += 1;
      const rows = results.shift() ?? [];
      const chain: Record<string, unknown> = new Proxy({}, {
        get: (_t, key) => key === "then" ? (resolve: (v: unknown) => void) => resolve(rows) : () => chain,
      });
      return chain;
    },
  };
  return { tx: tx as never, selects: () => selects };
}

const run = { id: "run-2", companyId: "c", agentId: "a", retryOfRunId: null, contextSnapshot: null } as never;
const agent = (defaultEnvironmentId: string | null) => [{ companyId: "c", permissions: {}, defaultEnvironmentId }];
const settings = (over: Record<string, unknown> = {}) => [{ defaultEnvironmentId: null, general: {}, experimental: {}, ...over }];

describe("claim-time host locality", () => {
  afterEach(() => { delete process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS; warn.mockClear(); });

  it("treats a local agent default as local", async () => {
    const { tx } = fakeTx([agent("e1"), settings(), [{ driver: "local" }]]);
    expect(await resolveHostRunLocality(tx, run)).toBe(true);
  });

  it("treats a run with no environment anywhere as local without logging", async () => {
    const { tx } = fakeTx([agent(null), settings()]);
    expect(await resolveHostRunLocality(tx, run)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the instance default when the agent has none, so a remote instance default is not local", async () => {
    const { tx } = fakeTx([agent(null), settings({ defaultEnvironmentId: "e2" }), [{ driver: "plugin" }]]);
    expect(await resolveHostRunLocality(tx, run)).toBe(false);
  });

  it("classes a remote agent default as not local", async () => {
    const { tx } = fakeTx([agent("e1"), settings(), [{ driver: "ssh" }]]);
    expect(await resolveHostRunLocality(tx, run)).toBe(false);
  });

  it("classes a local result as not local under managed-sandbox-only", async () => {
    const { tx } = fakeTx([agent("e1"), settings({ experimental: { enableManagedSandboxOnly: true } }), [{ driver: "local" }]]);
    expect(await resolveHostRunLocality(tx, run)).toBe(false);
  });

  it("classes every run as not local when execution is forced to Kubernetes", async () => {
    const { tx, selects } = fakeTx([agent("e1"), settings({ general: { executionMode: "kubernetes" } })]);
    expect(await resolveHostRunLocality(tx, run)).toBe(false);
    expect(selects()).toBe(2);
  });

  const leased = () => ({ ...(run as object), contextSnapshot: { paperclipEnvironment: { leaseId: randomUUID() } } } as never);
  const leaseRow = (over: Record<string, unknown> = {}) => [{ environmentId: "e9", heartbeatRunId: "run-2", issueId: null, metadata: { agentId: "a" }, ...over }];

  it("prefers the environment of a lease bound to this run over the agent default", async () => {
    const { tx } = fakeTx([agent("e1"), settings(), leaseRow(), [{ driver: "sandbox" }]]);
    expect(await resolveHostRunLocality(tx, leased())).toBe(false);
  });

  it("ignores a lease inherited from a predecessor run, so a retry resolves its current target", async () => {
    const { tx } = fakeTx([agent("e1"), settings(), leaseRow({ heartbeatRunId: "run-1" }), [{ driver: "local" }]]);
    expect(await resolveHostRunLocality(tx, leased())).toBe(true);
  });

  it("ignores a lease bound to another agent or issue", async () => {
    const other = fakeTx([agent("e1"), settings(), leaseRow({ metadata: { agentId: "other" } }), [{ driver: "local" }]]);
    expect(await resolveHostRunLocality(other.tx, leased())).toBe(true);
    const issue = fakeTx([agent("e1"), settings(), leaseRow({ issueId: randomUUID() }), [{ driver: "local" }]]);
    expect(await resolveHostRunLocality(issue.tx, leased())).toBe(true);
  });

  it("counts a run as local and logs when its environment row cannot be found", async () => {
    const { tx } = fakeTx([agent("e1"), settings(), []]);
    expect(await resolveHostRunLocality(tx, run)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "environment_not_found" }), expect.any(String));
  });

  it("counts a run as local and logs when resolution throws", async () => {
    const tx = { select: () => { throw new Error("db down"); } } as never;
    expect(await resolveHostRunLocality(tx, run)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "resolution_failed" }), expect.any(String));
  });

  it("records the classification on the run profile only when the cap is on", async () => {
    expect(await hostRunProfileFor(fakeTx([]).tx, run)).toEqual({});
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "3";
    const { tx } = fakeTx([agent("e1"), settings(), [{ driver: "ssh" }]]);
    expect(await hostRunProfileFor(tx, run)).toMatchObject({ hostRun: { limit: 3, local: false } });
  });
});

describe("host run admission", () => {
  afterEach(() => { delete process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS; warn.mockClear(); });

  it("refuses a non-head local run with the ordering reason, not the slots-full reason", async () => {
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "2";
    const { tx } = fakeTx([agent("e1"), settings(), [{ driver: "local" }], [{ id: "run-1" }]]);
    const error = await assertAgentRunSlotFree(tx, run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRunOrderingRefused);
    expect(error).not.toBeInstanceOf(HostRunSlotsFull);
    expect((error as HostRunOrderingRefused).headRunId).toBe("run-1");
  });

  it("reports the real running count when the host is full", async () => {
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "2";
    const { tx } = fakeTx([agent(null), settings(), [{ id: "run-2" }], [{ count: 2 }]]);
    const error = await assertAgentRunSlotFree(tx, run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRunSlotsFull);
    expect(error).toMatchObject({ running: 2, limit: 2 });
  });

  it("skips host admission entirely for a run that resolves to a remote target", async () => {
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "1";
    // Locality lookups, then only the per-agent count and limit; no host head or count queries.
    const { tx, selects } = fakeTx([agent("e1"), settings(), [{ driver: "plugin" }], [{ count: 0 }], [{ limit: 5 }]]);
    await expect(assertAgentRunSlotFree(tx, run)).resolves.toBeUndefined();
    expect(selects()).toBe(5);
  });

  it("does not resolve locality when the host cap is off", async () => {
    const { tx, selects } = fakeTx([[{ count: 0 }], [{ limit: 5 }]]);
    await expect(assertAgentRunSlotFree(tx, run)).resolves.toBeUndefined();
    expect(selects()).toBe(2);
  });
});
