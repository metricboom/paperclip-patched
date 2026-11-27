import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../../middleware/logger.js", () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// The predicate under test decides from the parsed shape; parse validation itself is covered by
// the runner contract tests. A sentinel stands in for input the real parser would reject.
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    parseNativeExecutionInput: (value: unknown) => {
      if (value && typeof value === "object" && (value as { __invalidNativeInput?: boolean }).__invalidNativeInput) {
        throw new Error("invalid native execution input");
      }
      return value;
    },
  };
});

vi.mock("../native-runtime/native-workspace-sync.js", () => ({
  readNativeWorkspaceSyncReference: (value: unknown) => {
    const candidate = value && typeof value === "object" ? (value as { leaseId?: unknown }) : null;
    return candidate && typeof candidate.leaseId === "string" ? { leaseId: candidate.leaseId } : null;
  },
}));

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

  // The executor reuses a saved lease only for a persisted native execution input, so these
  // runs are native with a parseable codex input; a legacy run never follows its saved lease.
  const nativeProfile = { nativeExecutionInput: { provider: { kind: "codex" } } };
  const leased = () => ({ ...(run as object), runtimeMode: "native", runnerProfileJson: nativeProfile,
    contextSnapshot: { paperclipEnvironment: { leaseId: randomUUID() } } } as never);
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

  describe("executor-equivalent saved lease", () => {
    const runnerAgent = (defaultEnvironmentId: string | null, over: Record<string, unknown> = {}) =>
      [{ companyId: "c", permissions: {}, defaultEnvironmentId, adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, ...over }];
    const nativeRun = (profile: Record<string, unknown>, contextSnapshot: Record<string, unknown>) =>
      ({ id: "run-2", companyId: "c", agentId: "a", retryOfRunId: null, contextSnapshot,
        runtimeMode: "native", runnerProfileJson: profile, driverKind: null }) as never;
    const codexProfile = { nativeExecutionInput: { provider: { kind: "codex" } } };

    it("honors a bound lease for a persisted native run, matching the executor", async () => {
      const { tx } = fakeTx([runnerAgent("e1"), settings(), leaseRow(), [{ driver: "sandbox" }]]);
      expect(await resolveHostRunLocality(tx, nativeRun(codexProfile,
        { paperclipEnvironment: { leaseId: randomUUID() } }))).toBe(false);
    });

    it("honors a bound lease that is local", async () => {
      const { tx } = fakeTx([runnerAgent("e1"), settings(), leaseRow(), [{ driver: "local" }]]);
      expect(await resolveHostRunLocality(tx, nativeRun(codexProfile,
        { paperclipEnvironment: { leaseId: randomUUID() } }))).toBe(true);
    });

    it("ignores the saved lease for a legacy run and resolves the current target", async () => {
      const legacyRun = { id: "run-2", companyId: "c", agentId: "a", retryOfRunId: null,
        contextSnapshot: { paperclipEnvironment: { leaseId: randomUUID() } }, runtimeMode: "legacy",
        runnerProfileJson: null, driverKind: null } as never;
      const { tx } = fakeTx([runnerAgent("e1"), settings(), [{ driver: "local" }]]);
      expect(await resolveHostRunLocality(tx, legacyRun)).toBe(true);
    });

    it("ignores the saved lease when the persisted native input cannot be parsed", async () => {
      const { tx } = fakeTx([runnerAgent("e1"), settings(), [{ driver: "local" }]]);
      expect(await resolveHostRunLocality(tx, nativeRun({ nativeExecutionInput: { __invalidNativeInput: true } },
        { paperclipEnvironment: { leaseId: randomUUID() } }))).toBe(true);
    });

    it("ignores the saved lease for a controller-only external provider run", async () => {
      const { tx } = fakeTx([runnerAgent("e1"), settings(), [{ driver: "local" }]]);
      expect(await resolveHostRunLocality(tx, nativeRun({ nativeExecutionInput: { provider: { kind: "openai_dot" } } },
        { paperclipEnvironment: { leaseId: randomUUID() } }))).toBe(true);
    });

    it("classes provider-API placement as not local, since the executor runs it controller-side", async () => {
      const { tx, selects } = fakeTx([runnerAgent("e1"), settings()]);
      expect(await resolveHostRunLocality(tx, nativeRun({ nativeExecutionInput: { provider: { kind: "cursor_cloud" } } },
        { paperclipEnvironment: { leaseId: randomUUID() } }))).toBe(false);
      expect(selects()).toBe(2);
    });

    it("follows the native workspace sync lease fallback like the executor", async () => {
      const { tx } = fakeTx([runnerAgent("e1"), settings(), leaseRow(), [{ driver: "sandbox" }]]);
      expect(await resolveHostRunLocality(tx, nativeRun(
        { ...codexProfile, nativeWorkspaceSync: { leaseId: randomUUID() } }, {}))).toBe(false);
    });

    it("ignores a lease whose environment does not match the saved environment id", async () => {
      const { tx } = fakeTx([runnerAgent("e1"), settings(), leaseRow(), [{ driver: "local" }]]);
      expect(await resolveHostRunLocality(tx, nativeRun(codexProfile,
        { paperclipEnvironment: { leaseId: randomUUID(), id: "other-env" } }))).toBe(true);
    });
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

  const candidateRow = (over: Record<string, unknown> = {}) => [{ id: "run-1", companyId: "c", agentId: "a2",
    retryOfRunId: null, contextSnapshot: null, runtimeMode: "legacy", runnerProfileJson: null, driverKind: null, ...over }];
  const candidateAgent = (defaultEnvironmentId: string | null) =>
    [{ companyId: "c", permissions: {}, defaultEnvironmentId }];

  it("refuses behind an older eligible local head with the ordering reason, not the slots-full reason", async () => {
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "2";
    const { tx } = fakeTx([
      agent("e1"), settings(), [{ driver: "local" }], // claiming run locality
      [{ id: "run-1" }],                              // queued candidates (FIFO)
      candidateRow(),                                 // candidate row
      [{ count: 0 }], [{ limit: 4 }],                 // candidate agent slots free
      candidateAgent("e1"), settings(), [{ driver: "local" }], // candidate resolves local
    ]);
    const error = await assertAgentRunSlotFree(tx, run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRunOrderingRefused);
    expect(error).not.toBeInstanceOf(HostRunSlotsFull);
    expect((error as HostRunOrderingRefused).headRunId).toBe("run-1");
  });

  it("skips a queued head whose company is inactive (filtered by the dispatch predicate)", async () => {
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "2";
    const { tx } = fakeTx([
      agent(null), settings(),                        // claiming run locality (local default)
      [{ id: "run-2" }],                              // inactive-company run-1 absent from candidates
      [{ count: 0 }],                                 // host running count
      [{ count: 0 }], [{ limit: 5 }],                 // claiming agent slots
    ]);
    await expect(assertAgentRunSlotFree(tx, run)).resolves.toBeUndefined();
  });

  it("skips a queued head whose agent has no free slots", async () => {
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "2";
    const { tx } = fakeTx([
      agent(null), settings(),
      [{ id: "run-1" }, { id: "run-2" }],
      candidateRow(),
      [{ count: 3 }], [{ limit: 3 }],                 // candidate agent full
      [{ count: 0 }],                                 // host running count
      [{ count: 0 }], [{ limit: 5 }],
    ]);
    await expect(assertAgentRunSlotFree(tx, run)).resolves.toBeUndefined();
  });

  it("skips a queued head that resolves remote for this host", async () => {
    process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS = "2";
    const { tx } = fakeTx([
      agent(null), settings(),
      [{ id: "run-1" }, { id: "run-2" }],
      candidateRow(),
      [{ count: 0 }], [{ limit: 4 }],
      candidateAgent("e9"), settings(), [{ driver: "ssh" }], // candidate resolves remote
      [{ count: 0 }],
      [{ count: 0 }], [{ limit: 5 }],
    ]);
    await expect(assertAgentRunSlotFree(tx, run)).resolves.toBeUndefined();
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
