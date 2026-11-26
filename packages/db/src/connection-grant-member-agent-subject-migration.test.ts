import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const migrationFile = "0511_dapper_skreet.sql";
const constraintName = "connection_grant_members_subject_type_check";

(support.supported ? describe : describe.skip)("connection grant member agent subject migration", () => {
  it("applies on a fresh database and on one that already holds user audience members", async () => {
    const database = await startEmbeddedPostgresTestDatabase("grant-member-agent-subject-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const constraintDefinition = async () => {
        const [row] = await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conname=${constraintName} AND conrelid='connection_grant_members'::regclass`;
        return String(row?.definition ?? "");
      };
      // Fresh database: every migration has run and the check admits agents.
      expect(await constraintDefinition()).toContain("'agent'");

      // Rewind to the previous state: user-only check and existing user members.
      const migration = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(migration).digest("hex");
      const [recorded] = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      expect(recorded!.count).toBe(1);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      await sql.unsafe(`ALTER TABLE connection_grant_members DROP CONSTRAINT ${constraintName}`);
      await sql.unsafe(`ALTER TABLE connection_grant_members ADD CONSTRAINT ${constraintName} CHECK (subject_type in ('user'))`);
      const [company] = await sql`INSERT INTO companies(name,issue_prefix) VALUES ('Audience fixture','GAM1') RETURNING id`;
      const [agent] = await sql`INSERT INTO agents(company_id,name) VALUES (${company!.id},'Audience agent') RETURNING id`;
      const [application] = await sql`INSERT INTO tool_applications(company_id,application_key,name,type,status)
        VALUES (${company!.id},'audience-fixture','Audience fixture','mcp_http','active') RETURNING id`;
      const [connection] = await sql`INSERT INTO tool_connections(company_id,application_id,name,uid,transport,status)
        VALUES (${company!.id},${application!.id},'Audience fixture','test/audience-fixture','mcp_remote','active') RETURNING id`;
      const [grant] = await sql`INSERT INTO connection_grants(company_id,connection_id,kind,status,is_default)
        VALUES (${company!.id},${connection!.id},'organization','active',true) RETURNING id`;
      await sql`INSERT INTO connection_grant_members(company_id,grant_id,subject_type,subject_id)
        VALUES (${company!.id},${grant!.id},'user','jamie'),(${company!.id},${grant!.id},'user','sales-user')`;
      await expect(sql`INSERT INTO connection_grant_members(company_id,grant_id,subject_type,subject_id)
        VALUES (${company!.id},${grant!.id},'agent',${agent!.id})`).rejects.toMatchObject({ code: "23514" });

      await applyPendingMigrations(database.connectionString);

      expect(await constraintDefinition()).toContain("'agent'");
      const users = await sql`SELECT subject_type, subject_id FROM connection_grant_members
        WHERE grant_id=${grant!.id} ORDER BY subject_id`;
      expect(users.map((row) => `${row.subject_type}:${row.subject_id}`)).toEqual(["user:jamie", "user:sales-user"]);
      await sql`INSERT INTO connection_grant_members(company_id,grant_id,subject_type,subject_id)
        VALUES (${company!.id},${grant!.id},'agent',${agent!.id})`;
      await expect(sql`INSERT INTO connection_grant_members(company_id,grant_id,subject_type,subject_id)
        VALUES (${company!.id},${grant!.id},'app','x')`).rejects.toMatchObject({ code: "23514" });
      const [history] = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      expect(history!.count).toBe(1);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 90_000);
});
