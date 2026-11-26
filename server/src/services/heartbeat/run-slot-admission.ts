import { agents, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import os from "node:os";
import { and, asc, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { maxConcurrentRunsSql } from "./timer-policy.js";

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

function hostRunLimit() {
  const parsed = Number.parseInt(process.env.PAPERCLIP_HOST_MAX_CONCURRENT_RUNS ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function configuredHostRunId() { return process.env.PAPERCLIP_HOST_ID?.trim() || os.hostname(); }

/** Metadata is omitted when the cap is off, preserving legacy run records. */
export function hostRunProfile() {
  const limit = hostRunLimit();
  return limit === null ? {} : { hostRun: { hostId: configuredHostRunId(), limit } };
}

type ClaimingRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "retryOfRunId" | "contextSnapshot">;

export async function assertAgentRunSlotFree(tx: Pick<Db, "select" | "execute">, run: ClaimingRun) {
  const hostLimit = hostRunLimit();
  if (hostLimit !== null) {
    const hostId = configuredHostRunId();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:host-local-runs:${hostId}`}, 0))`);
    const [head] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .leftJoin(environments, eq(environments.id, agents.defaultEnvironmentId))
      .where(and(eq(heartbeatRuns.status, "queued"), or(isNull(agents.defaultEnvironmentId), eq(environments.driver, "local"))))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)).limit(1);
    if (head && head.id !== run.id) throw new HostRunSlotsFull(hostId, hostLimit, hostLimit);
    const [runningOnHost] = await tx.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .leftJoin(environments, eq(environments.id, agents.defaultEnvironmentId))
      .where(and(eq(heartbeatRuns.status, "running"),
        sql`${heartbeatRuns.runnerProfileJson} #>> '{hostRun,hostId}' = ${hostId}`,
        or(isNull(agents.defaultEnvironmentId), eq(environments.driver, "local"))));
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
