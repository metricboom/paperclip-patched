import { randomUUID } from "node:crypto";
import { getTableName } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  goals,
  heartbeatRuns,
  issues,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
} from "@paperclipai/db";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type SelectRecord = { fields: Record<string, unknown> | undefined; table: string };

/** Wraps db.select so each `select(...).from(table)` is recorded, including tool-access reads. */
function recordingDb(db: Db) {
  const selects: SelectRecord[] = [];
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "select") return Reflect.get(target, property, receiver);
      return (...args: unknown[]) => {
        const builder = (target.select as (...input: unknown[]) => object)(...args);
        return new Proxy(builder, {
          get(inner, key, innerReceiver) {
            const value = Reflect.get(inner, key, innerReceiver);
            if (key !== "from" || typeof value !== "function") return value;
            return (table: Parameters<typeof getTableName>[0], ...rest: unknown[]) => {
              let name = "unknown";
              try { name = getTableName(table); } catch { /* subquery */ }
              selects.push({ fields: args[0] as Record<string, unknown> | undefined, table: name });
              return (value as (...input: unknown[]) => unknown).call(inner, table, ...rest);
            };
          },
        });
      };
    },
  });
  return { db: proxy as Db, selects };
}

describeEmbeddedPostgres("connection discovery budget", () => {
  let db!: Db;
  let cleanup: (() => Promise<void>) | undefined;
  let claims!: RuntimeToolsTokenClaims;
  const custom: Array<{ id: string; name: string }> = [];
  let notionConnectionId!: string;

  beforeAll(async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connection-discovery-budget-");
    cleanup = tempDb.cleanup;
    db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Discovery budget", issuePrefix: "DISC", requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "budget-user", name: "Budget user", email: "budget@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "budget-user", status: "active", membershipRole: "member" });
    await db.insert(goals).values({ id: goalId, companyId, title: "Discover", level: "task", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Seeker", role: "researcher", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, goalId, title: "Find a connection", status: "in_progress", priority: "medium", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: "budget-user", contextSnapshot: { issueId } });
    claims = { sub: agentId, company_id: companyId, run_id: runId, responsible_user_id: "budget-user", scope: "connection_intents", iat: 1, exp: 2, instance_id: "test" };

    // Several saved custom connections; only one names the searched word.
    const names = ["Ledger mirror", "Signal archive", "Heliotrope vault", "Quarry index", "Lantern notes", "Atlas drawer"];
    for (const name of names) {
      const [application] = await db.insert(toolApplications).values({ companyId, applicationKey: randomUUID(), name: `${name} app`, type: "mcp_http", status: "active" }).returning();
      const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, uid: randomUUID(), name, transport: "mcp_remote", authKind: "none", enabled: true, status: "active", healthStatus: "ok" }).returning();
      await db.insert(connectionGrants).values({ companyId, connectionId: connection!.id, kind: "organization", status: "active" });
      await db.insert(toolCatalogEntries).values({ companyId, connectionId: connection!.id, toolName: `${name.split(" ")[0]!.toLowerCase()}_read`, name: `${name} read`, description: `Read ${name}`, versionHash: "fixture-v1", status: "active", entryKind: "tool", inputSchema: { type: "object", properties: { secretShape: { type: "string" } } } });
      custom.push({ id: connection!.id, name });
    }
    // A saved catalog-provider connection (Notion), shared with the organization.
    const [notionApp] = await db.insert(toolApplications).values({ companyId, applicationKey: randomUUID(), name: "Indexed Notion", type: "mcp_http", status: "active", metadata: { sourceTemplateKey: "notion" } }).returning();
    const [notion] = await db.insert(toolConnections).values({ companyId, applicationId: notionApp!.id, uid: randomUUID(), name: "Team Notion", transport: "mcp_remote", authKind: "none", enabled: true, status: "active", healthStatus: "ok", config: { sourceTemplateKey: "notion" } }).returning();
    await db.insert(connectionGrants).values({ companyId, connectionId: notion!.id, kind: "organization", status: "active" });
    await db.insert(toolCatalogEntries).values({ companyId, connectionId: notion!.id, toolName: "notion_search", name: "Search", description: "Search pages", versionHash: "fixture-v1", status: "active", entryKind: "tool" });
    notionConnectionId = notion!.id;
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  function spiedAccess(database: Db) {
    const access = toolAccessService(database);
    return {
      access,
      grants: vi.spyOn(access, "listConnectionGrants"),
      effective: vi.spyOn(access, "getEffectiveToolAssignmentsForAgent"),
      getConnection: vi.spyOn(access, "getConnection"),
      getApplication: vi.spyOn(access, "getApplication"),
      assignments: vi.spyOn(access, "getConnectionAssignmentsForAgent"),
    };
  }

  it("reads a non-matching saved connection only for scoring, and resolves only the matching one", async () => {
    const spies = spiedAccess(db);
    const result = await connectionIntentService(db, { toolAccess: spies.access }).search(claims, "heliotrope");
    const match = custom.find(item => item.name === "Heliotrope vault")!;
    expect(result.results.map(item => item.service)).toEqual([`connection:${match.id}`]);
    // resolveService (connection + application reads) and readiness run only for the match.
    expect(spies.getConnection.mock.calls.map(call => call[0])).toEqual([match.id]);
    expect(spies.getApplication).toHaveBeenCalledTimes(1);
    const readinessIds = spies.assignments.mock.calls.flatMap(call => call[2] as string[]);
    for (const other of custom.filter(item => item.id !== match.id)) expect(readinessIds).not.toContain(other.id);
    // Grants are read only for saved connections (whose indexed tools feed scoring).
    const saved = new Set([...custom.map(item => item.id), notionConnectionId]);
    for (const [connectionId] of spies.grants.mock.calls) expect(saved.has(connectionId)).toBe(true);
  });

  it("reads each connection's grants and the agent's effective assignments at most once per search", async () => {
    for (const query of ["notion", "heliotrope", "zapier", "lantern notes", "github"]) {
      const spies = spiedAccess(db);
      await connectionIntentService(db, { toolAccess: spies.access }).search(claims, query);
      const perConnection = new Map<string, number>();
      for (const [connectionId] of spies.grants.mock.calls) perConnection.set(connectionId, (perConnection.get(connectionId) ?? 0) + 1);
      for (const [connectionId, count] of perConnection) expect({ query, connectionId, count }).toEqual({ query, connectionId, count: 1 });
      expect(spies.effective.mock.calls.length, query).toBeLessThanOrEqual(1);
    }
  });

  it("reads the catalog on the discovery path without tool schemas", async () => {
    const recorder = recordingDb(db);
    const result = await connectionIntentService(recorder.db).search(claims, "notion");
    expect(result.results.some(item => item.service === "notion")).toBe(true);
    const catalogReads = recorder.selects.filter(read => read.table === getTableName(toolCatalogEntries));
    expect(catalogReads.length).toBeGreaterThan(0);
    for (const read of catalogReads) {
      expect(read.fields).toBeDefined();
      expect(Object.keys(read.fields!)).not.toContain("inputSchema");
      expect(Object.keys(read.fields!)).not.toContain("outputSchema");
    }
  });

  it("returns discovery_timed_out when a read never resolves", async () => {
    const access = toolAccessService(db);
    const grants = vi.spyOn(access, "listConnectionGrants").mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    await expect(connectionIntentService(db, { toolAccess: access, discoveryDeadlineMs: 300 }).search(claims, "heliotrope"))
      .rejects.toMatchObject({ status: 504, details: { code: "discovery_timed_out" } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(grants).toHaveBeenCalled();
  });

  it("issues no further discovery reads after the deadline", async () => {
    const recorder = recordingDb(db);
    const access = toolAccessService(recorder.db);
    const real = access.listConnectionGrants.bind(access);
    // Every grant read is slow, so the work outlives the deadline.
    const grants = vi.spyOn(access, "listConnectionGrants").mockImplementation(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 250));
      return real(...args);
    });
    const effective = vi.spyOn(access, "getEffectiveToolAssignmentsForAgent");
    const service = connectionIntentService(recorder.db, { toolAccess: access, discoveryDeadlineMs: 200 });
    await expect(service.search(claims, "read")).rejects.toMatchObject({ status: 504, details: { code: "discovery_timed_out" } });
    const atDeadline = { grants: grants.mock.calls.length, effective: effective.mock.calls.length, catalog: recorder.selects.filter(read => read.table === getTableName(toolCatalogEntries)).length };
    await new Promise(resolve => setTimeout(resolve, 600));
    expect({ grants: grants.mock.calls.length, effective: effective.mock.calls.length, catalog: recorder.selects.filter(read => read.table === getTableName(toolCatalogEntries)).length }).toEqual(atDeadline);
    // Fewer grant reads were started than there are saved connections.
    expect(atDeadline.grants).toBeLessThan(custom.length + 1);
  });

  it("reads grant rows once per saved connection in one discovery call", async () => {
    // Before this change one "notion" search read connection_grants 13 times
    // for 7 saved connections (110 selects in all); now once each (62 selects).
    for (const query of ["notion", "heliotrope", "zapier", "github"]) {
      const recorder = recordingDb(db);
      await connectionIntentService(recorder.db).search(claims, query);
      const grantReads = recorder.selects.filter(read => read.table === getTableName(connectionGrants)).length;
      expect({ query, grantReads }).toEqual({ query, grantReads: custom.length + 1 });
      expect(recorder.selects.length, query).toBeLessThan(80);
    }
  });
});
