import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Teardown must release the run's home lease even when runtime-config cleanup rejects, and the
 * original error must still surface. A lease left behind keeps the generated home protected
 * from cleanup for as long as the server process lives.
 */
const {
  state,
  acquiredHomes,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  runAdapterExecutionTargetProcess,
  cleanupGeneratedCodexHomes,
} = vi.hoisted(() => ({
  state: { root: "" },
  acquiredHomes: [] as string[],
  prepareCodexRuntimeConfig: vi.fn(),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 123, startedAt: new Date().toISOString(),
  })),
  cleanupGeneratedCodexHomes: vi.fn(async () => ({ prunedRuntime: [], removedHomes: [], bytesFreedEstimate: 0 })),
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => vi.fn(),
  formatCodexAcpFallbackMessage: (reason: string) => `[paperclip] ${reason}\n`,
  resolveCodexExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, readPaperclipRuntimeSkillEntries };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    evaluateCodexCredentialReadiness: vi.fn(async () => ({
      managed: true, authMode: "api", ready: true, effectiveHome: state.root, sharedSourceHome: state.root,
    })),
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome: vi.fn(async () => state.root),
    resolveManagedCodexHomeDir: vi.fn(() => state.root),
    seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: state.root })),
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return { ...actual, prepareCodexRuntimeConfig };
});

// The real lease is taken on disk; only the home cleanup sweep is stubbed out.
vi.mock("./managed-home-cleanup.js", async () => {
  const actual = await vi.importActual<typeof import("./managed-home-cleanup.js")>("./managed-home-cleanup.js");
  return {
    ...actual,
    acquireRunLease: vi.fn(async (home: string) => {
      acquiredHomes.push(home);
      return actual.acquireRunLease(home);
    }),
    cleanupGeneratedCodexHomes,
  };
});

import { execute } from "./execute.js";

const CONNECTOR_DIGEST = "d".repeat(64);

function buildContext() {
  return {
    runId: "run-lease-release",
    agent: { id: "agent-1", companyId: "company-1", name: "Codex Coder", adapterType: "codex_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      outputInactivityTimeoutMs: null,
      env: { OPENAI_API_KEY: "test-key" },
      paperclipConnectorSkillDigest: CONNECTOR_DIGEST,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

async function leaseFiles(home: string): Promise<string[]> {
  return fs.readdir(path.join(home, ".paperclip-run-leases")).catch(() => []);
}

describe("codex execute teardown releases the generated home lease", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    acquiredHomes.length = 0;
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lease-release-"));
  });
  afterEach(async () => { await fs.rm(state.root, { recursive: true, force: true }); });

  it("releases the lease and still surfaces the error when runtime-config cleanup throws", async () => {
    let leasesDuringRun: string[] = [];
    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => {
      leasesDuringRun = await leaseFiles(acquiredHomes[0]!);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 123, startedAt: new Date().toISOString() };
    });
    prepareCodexRuntimeConfig.mockImplementation(async () => ({
      notes: [],
      cleanup: async () => { throw new Error("runtime config cleanup failed"); },
    }));

    await expect(execute(buildContext() as never)).rejects.toThrow("runtime config cleanup failed");

    expect(acquiredHomes).toHaveLength(1);
    const home = acquiredHomes[0]!;
    expect(home).toContain(path.join("connector-runtimes", "agent-1"));
    expect(leasesDuringRun).toHaveLength(1); // the run really held a lease file
    expect(await leaseFiles(home)).toEqual([]); // and teardown removed it despite the throw
  });

  it("releases the lease on a clean teardown too", async () => {
    prepareCodexRuntimeConfig.mockImplementation(async () => ({ notes: [], cleanup: async () => {} }));
    await execute(buildContext() as never);
    expect(acquiredHomes).toHaveLength(1);
    expect(await leaseFiles(acquiredHomes[0]!)).toEqual([]);
  });
});
