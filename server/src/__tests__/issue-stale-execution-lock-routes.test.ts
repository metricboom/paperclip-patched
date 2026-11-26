import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companyMemberships,
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
  runIdentityContexts,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { initializeRunIdentity } from "../services/run-identity.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale execution lock route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("stale issue execution lock routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-execution-lock-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(runIdentityContexts);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAgentAndRuns() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const currentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({ id: "board-user", name: "Board", email: "board@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "admin" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: currentRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, agentId, failedRunId, currentRunId };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  it("allows an assigned agent PATCH to recover a terminal stale executionRunId", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered execution lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Recovered execution lock");

    const row = await db
      .select({
        title: issues.title,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "Recovered execution lock",
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it.each([
    { status: "done" as const, title: "Done release preserves owner", completedAt: new Date(), retainAssignee: true },
    { status: "cancelled" as const, title: "Cancelled release preserves owner", cancelledAt: new Date(), retainAssignee: true },
    { status: "in_review" as const, title: "In review release preserves status" },
    { status: "blocked" as const, title: "Blocked release preserves status" },
    { status: "backlog" as const, title: "Backlog release relinquishes ownership" },
    { status: "todo" as const, title: "Todo release relinquishes ownership" },
    { status: "in_progress" as const, title: "Active release requeues work", expectedStatus: "todo" },
  ])(
    "$title and clears execution locks",
    async ({ status, title, completedAt, cancelledAt, retainAssignee, expectedStatus = status }) => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title,
        status,
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: currentRunId,
        executionRunId: currentRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
        ...(completedAt ? { completedAt } : {}),
        ...(cancelledAt ? { cancelledAt } : {}),
      });

      const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .post(`/api/issues/${issueId}/release`)
        .send();

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const expectedAssignee = retainAssignee ? agentId : null;
      expect(res.body).toMatchObject({ status: expectedStatus, assigneeAgentId: expectedAssignee });

      const row = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
          completedAt: issues.completedAt,
          cancelledAt: issues.cancelledAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row).toEqual({
        status: expectedStatus,
        assigneeAgentId: expectedAssignee,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        completedAt: completedAt ?? null,
        cancelledAt: cancelledAt ?? null,
      });

      const events = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      expect(events).toContainEqual(expect.objectContaining({
        action: "issue.released", companyId, agentId, runId: currentRunId,
      }));

      if (retainAssignee) {
        // Repeated cleanup, including by the board, must not erase attribution.
        const retried = await request(createApp(boardActor(companyId)))
          .post(`/api/issues/${issueId}/release`)
          .send();
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        expect(retried.body).toMatchObject({ status, assigneeAgentId: agentId, checkoutRunId: null, executionRunId: null });
        const [saved] = await db.select().from(issues).where(eq(issues.id, issueId));
        expect(saved).toMatchObject(row);
      }
    },
  );

  it("allows the rightful assignee to release after the owning run failed", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Failed run release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("lets the current assignee recover a timed_out stale checkout owner during PATCH", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const timedOutRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId,
      status: "timed_out",
      invocationSource: "manual",
      finishedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: timedOutRunId,
      executionRunId: timedOutRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered stale checkout lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("still returns 409 when a different live checkout owner is active", async () => {
    const { companyId, agentId, failedRunId } = await seedCompanyAgentAndRuns();
    const liveOwnerRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveOwnerRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: liveOwnerRunId,
      executionRunId: liveOwnerRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, failedRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should fail" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe("Issue run ownership conflict");
  });

  it("preserves live checkout ownership on checkout conflicts without retry side effects", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const contenderRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: contenderRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout race",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, contenderRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Issue checkout conflict",
    });

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    const checkoutActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.checked_out"));
    expect(checkoutActivity).toHaveLength(0);
  });

  it("restricts admin force-release to board users with company access and writes an audit event", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Admin force release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(403);
    await request(createApp({
      type: "board",
      userId: "outside-user",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    }))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(404);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/force-release?clearAssignee=true`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue).toMatchObject({
      id: issueId,
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(res.body.previous).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
    });

    const audit = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.admin_force_release"))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      action: "issue.admin_force_release",
      actorType: "user",
      actorId: "board-user",
      details: {
        issueId,
        actorUserId: "board-user",
        prevCheckoutRunId: currentRunId,
        prevExecutionRunId: failedRunId,
        clearAssignee: true,
      },
    });
  });

  async function seedCompanyDefaultRoot() {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const [root] = await db.insert(runIdentityContexts).values({
      companyId,
      runId: currentRunId,
      revision: 1,
      responsibleUserId: "fallback-user",
      cause: "company_default",
      correlationId: "dispatch",
      acceptedAt: new Date(),
    }).returning();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Rooted in a company default",
      status: "in_progress",
      assigneeAgentId: agentId,
      originIdentityContextId: root!.id,
      continuationIdentityContextId: root!.id,
      responsibleUserId: "fallback-user",
    });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      payload: { version: 1, questions: [] },
      sourceIdentityContextId: root!.id,
    }).returning();
    return { companyId, agentId, currentRunId, issueId, root: root!, interactionId: interaction!.id };
  }

  // The heartbeat derives a run's parent identity context from the task's
  // pointers (continuation first, then origin). Mirror that to show what the
  // next run on the task would inherit.
  async function nextRunIdentity(companyId: string, agentId: string, issueId: string, responsibleUserId: string, cause: string) {
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "assignment",
      startedAt: new Date(), contextSnapshot: { issueId } });
    return initializeRunIdentity(db, {
      companyId, runId, issueId, responsibleUserId, cause,
      parentContextId: task!.continuationIdentityContextId ?? task!.originIdentityContextId,
    });
  }

  it("restricts identity-root repair to board users of the task's company and audits the detachment", async () => {
    const { companyId, agentId, currentRunId, issueId, root, interactionId } = await seedCompanyDefaultRoot();
    const repair = (actor: Express.Request["actor"]) => request(createApp(actor))
      .post(`/api/issues/${issueId}/admin/repair-identity-root`);

    // An agent cannot lift the boundary its own executions are held by.
    await repair(agentActor(companyId, agentId, currentRunId)).expect(403);
    // Neither can an unauthenticated caller or a read-only member of the company.
    await repair({ type: "none", source: "none" }).expect(403);
    await repair({
      type: "board",
      userId: "viewer-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "viewer", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    }).expect(403);
    // A board user of another company cannot even learn the task exists.
    await repair({
      type: "board",
      userId: "outside-user",
      companyIds: [randomUUID()],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    }).expect(404);
    const [untouched] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(untouched).toMatchObject({ originIdentityContextId: root.id, continuationIdentityContextId: root.id, responsibleUserId: "fallback-user" });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.admin_repair_identity_root"))).toEqual([]);

    const res = await repair(boardActor(companyId)).send();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      issueId,
      detachedOrigin: true,
      detachedContinuation: true,
      detachedInteractionIds: [interactionId],
      clearedResponsibleUserId: true,
      detachedContextIds: [root.id],
    });

    const [repaired] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(repaired.originIdentityContextId).toBeNull();
    expect(repaired.continuationIdentityContextId).toBeNull();
    expect(repaired.responsibleUserId).toBeNull();
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(card.sourceIdentityContextId).toBeNull();
    // The context itself survives: the fallback execution happened, and who was
    // accountable for it is not the repair's to erase.
    const [context] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, root.id));
    expect(context).toMatchObject({ cause: "company_default", responsibleUserId: "fallback-user" });

    const audit = await db
      .select({ action: activityLog.action, actorId: activityLog.actorId, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.admin_repair_identity_root"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: "board-user",
      details: { issueId, actorUserId: "board-user", detachedOrigin: true },
    });

    // Re-running is safe and reports nothing left to detach.
    const again = await repair(boardActor(companyId)).send().expect(200);
    expect(again.body).toMatchObject({
      detachedOrigin: false, detachedContinuation: false, detachedInteractionIds: [],
      clearedResponsibleUserId: false, detachedContextIds: [],
    });
  });

  it("lets the next run on a repaired task decide its identity fresh instead of inheriting company default", async () => {
    const { companyId, agentId, issueId, root } = await seedCompanyDefaultRoot();

    // Before repair: even with an attributable seed, the next run inherits the
    // poisoned root and stays company_default.
    const before = await nextRunIdentity(companyId, agentId, issueId, "parent-user", "dispatch");
    expect(before).toMatchObject({ parentContextId: root.id, cause: "company_default", responsibleUserId: "fallback-user" });

    await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/repair-identity-root`).send().expect(200);

    // After repair: the next run has no inherited root, so its own seed decides,
    // and the run after that continues from the clean context.
    const after = await nextRunIdentity(companyId, agentId, issueId, "parent-user", "dispatch");
    expect(after).toMatchObject({ parentContextId: null, cause: "dispatch", responsibleUserId: "parent-user" });
    const following = await nextRunIdentity(companyId, agentId, issueId, "parent-user", "dispatch");
    expect(following).toMatchObject({ parentContextId: after.id, cause: "dispatch", responsibleUserId: "parent-user" });
  });

  it("re-roots a repaired task in company default when its next run still has nobody to attribute", async () => {
    const { companyId, agentId, issueId, root } = await seedCompanyDefaultRoot();
    await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/repair-identity-root`).send().expect(200);

    // Repair grants nothing by itself: a seed that still reaches the company
    // fallback is company_default again, with a fresh root of its own...
    const stillFallback = await nextRunIdentity(companyId, agentId, issueId, "fallback-user", "company_default");
    expect(stillFallback).toMatchObject({ parentContextId: null, cause: "company_default" });
    expect(stillFallback.id).not.toBe(root.id);
    // ...and that fresh context becomes the task's continuation pointer, so a
    // later run inherits company_default again even with an attributable seed.
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task!.continuationIdentityContextId).toBe(stillFallback.id);
    const later = await nextRunIdentity(companyId, agentId, issueId, "parent-user", "dispatch");
    expect(later).toMatchObject({ parentContextId: stillFallback.id, cause: "company_default" });
  });

  it("does not root or attribute an agent-created task in the creator's company-default identity", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    await db.insert(authUsers).values({ id: "fallback-user", name: "Fallback", email: "fallback@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "fallback-user", status: "active", membershipRole: "member" });
    const createAs = async (cause: string) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "assignment", startedAt: new Date() });
      const context = await initializeRunIdentity(db, { companyId, runId, responsibleUserId: "fallback-user", cause });
      // These are the fields the authentication middleware derives from the
      // run's accepted identity context.
      const actor = { ...agentActor(companyId, agentId, runId), identityContextId: context.id, onBehalfOfUserId: "fallback-user",
        onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "active" }] };
      const res = await request(createApp(actor))
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: `Created under ${cause}`, status: "backlog" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [created] = await db.select().from(issues).where(eq(issues.id, res.body.id));
      return { context, created: created! };
    };

    const fallback = await createAs("company_default");
    expect(fallback.context.cause).toBe("company_default");
    expect(fallback.created.originIdentityContextId).toBeNull();
    expect(fallback.created.responsibleUserId).toBeNull();

    // Control: an attributable creator still roots and attributes the task.
    const attributed = await createAs("dispatch");
    expect(attributed.created.originIdentityContextId).toBe(attributed.context.id);
    expect(attributed.created.responsibleUserId).toBe("fallback-user");
  });

  it("self-heals a stale checkoutRunId via clearCheckoutRunIfTerminal on checkout (Fix B path)", async () => {
    // Reproduces the recurrence pattern: prior owning run died, executionRunId
    // was cleared by releaseIssueExecutionAndPromote, but checkoutRunId stayed
    // pinned to the dead run. The new agent's POST /checkout would 409 forever
    // without the clearCheckoutRunIfTerminal helper in svc.checkout.
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock after reassignment",
      // Status off in_progress + checkoutRunId still set — adoptStaleCheckoutRun
      // cannot recover from this; only clearCheckoutRunIfTerminal can.
      status: "todo",
      priority: "high",
      assigneeAgentId: otherAgentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp(agentActor(companyId, otherAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: otherAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: otherAgentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("keeps a report's live run bound when its manager tries to move the running task to backlog", async () => {
    // A lead "pausing" work by editing statuses: before this guard the status
    // change released the execution lock and left the report's run running,
    // no longer bound to its task.
    const { companyId, agentId: reportAgentId, currentRunId: reportRunId } = await seedCompanyAgentAndRuns();
    const leadAgentId = randomUUID();
    const leadRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: leadAgentId,
      companyId,
      name: "LaunchLead",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents).set({ reportsTo: leadAgentId }).where(eq(agents.id, reportAgentId));
    await db.insert(heartbeatRuns).values({
      id: leadRunId,
      companyId,
      agentId: leadAgentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Build the launch website",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: reportAgentId,
      checkoutRunId: reportRunId,
      executionRunId: reportRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, reportRunId));

    const res = await request(createApp(agentActor(companyId, leadAgentId, leadRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "backlog" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "issue_status_change_live_run", runId: reportRunId });
    expect(res.body.error).toContain("More task actions, then Pause subtree");

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: reportAgentId,
      checkoutRunId: reportRunId,
      executionRunId: reportRunId,
    });
    const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, reportRunId)).then((rows) => rows[0]);
    expect(run?.status).toBe("running");
  });

  it("rejects a status change whose checked execution lock changed before the write", async () => {
    // The route checks the lock, then a checkout lands before the write. The
    // write must not release the newly acquired lock.
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checked out after the check",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    await expect(issueService(db).update(issueId, {
      status: "backlog",
      expectedExecutionLock: { executionRunId: null, checkoutRunId: null },
    })).rejects.toMatchObject({ status: 409, details: { code: "issue_execution_lock_changed" } });

    const row = await db
      .select({ status: issues.status, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ status: "in_progress", checkoutRunId: currentRunId, executionRunId: currentRunId });

    // A lock that was released after the check (the route's own confirmed Stop)
    // does not block the write.
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null }).where(eq(issues.id, issueId));
    const updated = await issueService(db).update(issueId, {
      status: "backlog",
      expectedExecutionLock: { executionRunId: currentRunId, checkoutRunId: currentRunId },
    });
    expect(updated?.status).toBe("backlog");
  });
});
