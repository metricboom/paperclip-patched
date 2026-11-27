import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Parse validation belongs to the runner contract tests; here the parsed shape drives the rule.
// A sentinel stands in for input the real parser would reject.
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

import { savedAdmittedLeaseId } from "./admitted-lease.js";

const agent = (over: Record<string, unknown> = {}) =>
  ({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, ...over });
const run = (over: Record<string, unknown> = {}) =>
  ({ runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: { provider: { kind: "codex" } } },
    contextSnapshot: {}, driverKind: null, ...over });

describe("savedAdmittedLeaseId", () => {
  it("returns the saved lease for a persisted native run", () => {
    const leaseId = randomUUID();
    expect(savedAdmittedLeaseId({ run: run({ contextSnapshot: { paperclipEnvironment: { leaseId } } }), agent: agent() }))
      .toBe(leaseId);
  });

  it("returns null for a legacy run even when a lease id is saved", () => {
    expect(savedAdmittedLeaseId({ run: run({ runtimeMode: "legacy", runnerProfileJson: null,
      contextSnapshot: { paperclipEnvironment: { leaseId: randomUUID() } } }), agent: agent() })).toBeNull();
  });

  it("returns null for a controller-only external provider run", () => {
    expect(savedAdmittedLeaseId({ run: run({
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "openai_dot" } } },
      contextSnapshot: { paperclipEnvironment: { leaseId: randomUUID() } } }), agent: agent() })).toBeNull();
  });

  it("returns null for provider-API placement", () => {
    expect(savedAdmittedLeaseId({ run: run({
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "cursor_cloud" } } },
      contextSnapshot: { paperclipEnvironment: { leaseId: randomUUID() } } }), agent: agent() })).toBeNull();
  });

  it("falls back to the native workspace sync lease reference", () => {
    const leaseId = randomUUID();
    expect(savedAdmittedLeaseId({ run: run({
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "codex" } }, nativeWorkspaceSync: { leaseId } } }),
      agent: agent() })).toBe(leaseId);
  });

  it("prefers the saved paperclipEnvironment lease over the sync fallback", () => {
    const saved = randomUUID();
    expect(savedAdmittedLeaseId({ run: run({
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "codex" } }, nativeWorkspaceSync: { leaseId: randomUUID() } },
      contextSnapshot: { paperclipEnvironment: { leaseId: saved } } }), agent: agent() })).toBe(saved);
  });

  it("treats a blank saved lease id as absent", () => {
    const fallback = randomUUID();
    expect(savedAdmittedLeaseId({ run: run({
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "codex" } }, nativeWorkspaceSync: { leaseId: fallback } },
      contextSnapshot: { paperclipEnvironment: { leaseId: "  " } } }), agent: agent() })).toBe(fallback);
  });

  it("propagates a parser failure so callers can reject or fall back explicitly", () => {
    expect(() => savedAdmittedLeaseId({ run: run({
      runnerProfileJson: { nativeExecutionInput: { __invalidNativeInput: true } } }), agent: agent() })).toThrow();
  });
});
