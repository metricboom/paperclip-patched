import { agents, environmentLeases, environments, heartbeatRuns, instanceSettings, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import os from "node:os";
import { and, asc, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { maxConcurrentRunsSql } from "./timer-policy.js";
import { logger } from "../../middleware/logger.js";
import { parseObject } from "../../adapters/utils.js";
import { isExecutionForcedToKubernetes } from "../execution-allowlist.js";
import { parseIssueExecutionWorkspaceSettings } from "../execution-workspace-policy.js";
import { resolveCoreTrustPreset } from "../trust-preset-resolver.js";

import { resolveProviderApiPlacement } from "../native-runtime/provider-api-placement.js";
import { savedAdmittedLeaseId } from "./admitted-lease.js";

export class AgentRunSlotsFull extends Error {
  constructor(readonly agentId: string, readonly running: number, readonly limit: number) {
    super("The agent already runs as many runs at once as it allows.");
    this.name = "AgentRunSlotsFull";
  }
}

export class HostRunSlotsFull extends Error {
  constructor(readonly hostId: string, readonly running: number, readonly limit: number) {
    super("This host has reached its configured concurrent local-run limit.");
    this.name = "HostRunSlotsFull";
  }
}

/** A run that is not the oldest queued local run on this host may not start yet. This is an ordering refusal, not a full host. */
export class HostRunOrderingRefused extends Error {
  constructor(readonly hostId: string, readonly headRunId: string) {
    super("This host starts local runs in queue order, and an older local run is waiting.");
    this.name = "HostRunOrderingRefused";
  }
}

function hostRunLimit() {
  const parsed = Number.parseInt(process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function configuredHostRunId() { return process.env.PAPERCLIP_HOST_ID?.trim() || os.hostname(); }

/**
 * Resolves, at claim time, whether the run will execute on this host. The order follows the
 * execution resolver (environment-selection.ts, resolveExecutionWorkspaceEnvironmentId):
 * an already admitted lease's environment, then the low-trust issue environment, the agent
 * default, the instance default, and finally the local default. Kubernetes forcing and the
 * managed-sandbox-only policy move a local result off the host, so both count as not local.
 * Anything that cannot be resolved counts as local and is logged, so nothing escapes the cap.
 * Provider-API placement (controller-only external providers) resolves no environment in the
 * executor, so those runs are not local. A saved lease decides the target only when the executor
 * would actually reuse it (savedAdmittedLeaseId, shared with environment-selection.ts) and the
 * lease is bound to this run, issue, agent, and saved environment; otherwise the current target
 * is resolved.
 */
export async function resolveHostRunLocality(tx: Pick<Db, "select">, run: ClaimingRun): Promise<boolean> {
  const unresolved = (reason: string, extra?: Record<string, unknown>) => {
    logger.warn({ runId: run.id, agentId: run.agentId, companyId: run.companyId, reason, ...extra },
      "host run locality could not be resolved; counting the run as local");
    return true;
  };
  try {
    const context = parseObject(run.contextSnapshot);
    const [agent] = await tx.select({ companyId: agents.companyId, permissions: agents.permissions, defaultEnvironmentId: agents.defaultEnvironmentId,
      adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents).where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId))).limit(1);
    if (!agent) return unresolved("agent_not_found");
    const [settings] = await tx.select({ defaultEnvironmentId: instanceSettings.defaultEnvironmentId, general: instanceSettings.general, experimental: instanceSettings.experimental })
      .from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
    const executionMode = parseObject(settings?.general).executionMode;
    if (isExecutionForcedToKubernetes({ executionMode: executionMode === "kubernetes" ? "kubernetes" : "any" })) return false;

    // Controller-side placements resolve no environment in the executor, so they are never local.
    // A malformed persisted input cannot be reused by the executor either; fall through to the
    // current target instead of trusting the saved lease.
    let leaseId: string | null = null;
    try {
      if (resolveProviderApiPlacement({ run, agent }) !== null) return false;
      leaseId = savedAdmittedLeaseId({ run, agent });
    } catch {
      leaseId = null;
    }

    let environmentId: string | null = null;
    if (leaseId !== null && isUuidLike(leaseId)) {
      const [lease] = await tx.select({ environmentId: environmentLeases.environmentId, heartbeatRunId: environmentLeases.heartbeatRunId,
        issueId: environmentLeases.issueId, metadata: environmentLeases.metadata }).from(environmentLeases)
        .where(and(eq(environmentLeases.id, leaseId), eq(environmentLeases.companyId, run.companyId))).limit(1);
      // Same binding the executor checks (environment-selection.ts): a retry that merely inherits a
      // predecessor's lease id must not decide where this run executes.
      const contextIssueId = typeof context.issueId === "string" ? context.issueId : null;
      const savedEnvironmentId = parseObject(context.paperclipEnvironment).id;
      const bound = lease && lease.environmentId && lease.heartbeatRunId === run.id && (lease.issueId ?? null) === contextIssueId
        && parseObject(lease.metadata).agentId === run.agentId
        && (typeof savedEnvironmentId !== "string" || savedEnvironmentId === lease.environmentId);
      environmentId = bound ? lease.environmentId ?? null : null;
    }
    if (!environmentId) {
      const issueId = context.issueId;
      let lowTrustIssueEnvironmentId: string | null = null;
      if (typeof issueId === "string" && isUuidLike(issueId)) {
        const [issue] = await tx.select({ companyId: issues.companyId, executionPolicy: issues.executionPolicy, executionWorkspaceSettings: issues.executionWorkspaceSettings })
          .from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).limit(1);
        if (issue) {
          const trust = resolveCoreTrustPreset({
            companyId: agent.companyId,
            agent: { companyId: agent.companyId, permissions: agent.permissions },
            issue: { companyId: issue.companyId, executionPolicy: issue.executionPolicy },
            run: { companyId: agent.companyId, executionPolicy: context.executionPolicy },
          });
          if (trust.kind === "low_trust_review") {
            lowTrustIssueEnvironmentId = parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings, { includeEnvironmentId: true })?.environmentId ?? null;
          }
        }
      }
      environmentId = lowTrustIssueEnvironmentId ?? agent.defaultEnvironmentId ?? settings?.defaultEnvironmentId ?? null;
    }
    let driver: string | null = null;
    if (environmentId) {
      const [environment] = await tx.select({ driver: environments.driver }).from(environments).where(eq(environments.id, environmentId)).limit(1);
      if (!environment) return unresolved("environment_not_found", { environmentId });
      driver = environment.driver;
    }
    const isLocal = driver === null || driver === "local";
    if (isLocal && parseObject(settings?.experimental).enableManagedSandboxOnly === true) return false;
    return isLocal;
  } catch (error) {
    return unresolved("resolution_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Metadata is omitted when the cap is off, preserving legacy run records. `local` is the claim-time classification the host count uses. */
export async function hostRunProfileFor(tx: Pick<Db, "select">, run: ClaimingRun) {
  const limit = hostRunLimit();
  return limit === null ? {} : { hostRun: { hostId: configuredHostRunId(), limit, local: await resolveHostRunLocality(tx, run) } };
}

type ClaimingRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "retryOfRunId" | "contextSnapshot" | "runtimeMode" | "runnerProfileJson" | "driverKind">;

export async function assertAgentRunSlotFree(tx: Pick<Db, "select" | "execute">, run: ClaimingRun) {
  const hostLimit = hostRunLimit();
  // The host cap only applies to runs that execute on this host. The target is resolved at claim
  // time with the same precedence the executor uses, not read from the agent default alone.
  const claimsRemotely = hostLimit !== null && !(await resolveHostRunLocality(tx, run));
  if (hostLimit !== null && !claimsRemotely) {
    const hostId = configuredHostRunId();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:host-local-runs:${hostId}`}, 0))`);
    const [head] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .leftJoin(environments, eq(environments.id, agents.defaultEnvironmentId))
      .where(and(eq(heartbeatRuns.status, "queued"), or(isNull(agents.defaultEnvironmentId), eq(environments.driver, "local"))))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)).limit(1);
    if (head && head.id !== run.id) throw new HostRunOrderingRefused(hostId, head.id);
    // Counts runs recorded as local at their own claim. A record without a classification counts as local.
    const [runningOnHost] = await tx.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.status, "running"),
        sql`${heartbeatRuns.runnerProfileJson} #>> '{hostRun,hostId}' = ${hostId}`,
        sql`coalesce(${heartbeatRuns.runnerProfileJson} #>> '{hostRun,local}', 'true') <> 'false'`));
    const running = Number(runningOnHost?.count ?? 0);
    if (running >= hostLimit) throw new HostRunSlotsFull(hostId, running, hostLimit);
  }
  const previousRunId = (run.contextSnapshot as Record<string, unknown> | null)?.previousRunId;
  const replaced = [run.id, run.retryOfRunId, typeof previousRunId === "string" ? previousRunId : null]
    .filter((id): id is string => typeof id === "string" && isUuidLike(id));
  const [running] = await tx.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "running"),
    notInArray(heartbeatRuns.id, replaced)));
  const [agent] = await tx.select({ limit: maxConcurrentRunsSql() }).from(agents)
    .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
  if (!agent) return;
  const count = Number(running?.count ?? 0);
  const limit = Number(agent.limit);
  if (count >= limit) throw new AgentRunSlotsFull(run.agentId, count, limit);
}
