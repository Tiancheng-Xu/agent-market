import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, expect, it } from "vitest";
import { GovernanceService, type Database } from "./service";

const owner = `0x${"1".repeat(40)}`, operator = `0x${"2".repeat(40)}`, reviewer = `0x${"3".repeat(40)}`;
const task = "11111111-1111-4111-8111-111111111111", agent = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
afterEach(async () => { await db?.close(); });
async function setup() {
  db = new PGlite();
  const core = readFileSync(new URL("../../../../database/migrations/0001_agent_market_core.sql", import.meta.url), "utf8")
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace("embedding vector(384)", "embedding double precision[]");
  await db.exec(core);
  await db.exec(readFileSync(new URL("../../../../database/migrations/0011_l2_orders.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../../../../database/migrations/0021_governance.sql", import.meta.url), "utf8"));
  await db.query("INSERT INTO agent_market.agents(id,owner_wallet,name,description,capabilities,status) VALUES ($1,$2,'test','description',ARRAY['code'],'draft')", [agent,owner]);
  await db.query("INSERT INTO agent_market.tasks(id,publisher_wallet,title,description,budget_atomic,status,request_id) VALUES ($1,$2,'task','description',100,'in_progress',$1)", [task,owner]);
  await db.query("INSERT INTO agent_market.governance_roles(wallet,role,granted_by,reason) VALUES ($1,'operator','bootstrap','test'),($2,'reviewer','bootstrap','test')", [operator,reviewer]);
  const adapt = (conn: Pick<PGlite, "query">): Database => ({
    query: async (sql, values = []) => (await conn.query<Record<string, unknown>>(sql, values)).rows,
    transaction: fn => db.transaction(tx => fn(adapt(tx))),
  });
  return new GovernanceService(adapt(db));
}
const command = (service: GovernanceService, wallet: string, action: Record<string, unknown>, key = crypto.randomUUID()) =>
  service.execute(wallet, key, crypto.randomUUID(), action);
it("halts atomically, rejects self/unauthorized review, resumes exact saved status and audits", async () => {
  const s = await setup();
  const halt = { action: "halt", targetId: task, expectedVersion: 1, reason: "incident" };
  await expect(command(s, owner, halt)).rejects.toThrow("GOVERNANCE_FORBIDDEN");
  await command(s, operator, halt, "halt-key-001");
  await command(s, operator, halt, "halt-key-001");
  await expect(command(s, operator, { ...halt, reason: "changed" }, "halt-key-001")).rejects.toThrow("GOVERNANCE_IDEMPOTENCY_CONFLICT");
  const proposal = await command(s, operator, { action: "resume", targetId: task, expectedVersion: 2, reason: "resolved" });
  await db.query("INSERT INTO agent_market.governance_roles(wallet,role,granted_by,reason) VALUES ($1,'reviewer','bootstrap','test')", [operator]);
  await expect(command(s, operator, { action: "review", targetId: proposal.id, decision: "approve", reason: "self" })).rejects.toThrow("GOVERNANCE_SELF_REVIEW");
  await expect(command(s, owner, { action: "review", targetId: proposal.id, decision: "approve", reason: "no role" })).rejects.toThrow("GOVERNANCE_FORBIDDEN");
  await command(s, reviewer, { action: "review", targetId: proposal.id, decision: "approve", reason: "checked" });
  expect((await db.query("SELECT status,version,manual_review_from_status FROM agent_market.tasks")).rows[0]).toEqual({status:"in_progress",version:3,manual_review_from_status:null});
  expect((await db.query("SELECT count(*)::int AS count FROM agent_market.governance_audit")).rows[0]).toEqual({count:3});
});
it("rejects stale release approvals and rolls back the whole review", async () => {
  const s = await setup();
  const p = await command(s, owner, {action:"propose_release",targetId:agent,expectedVersion:1,reason:"ready"});
  await db.query("UPDATE agent_market.agents SET version=2 WHERE id=$1",[agent]);
  await expect(command(s, reviewer, {action:"review",targetId:p.id,decision:"approve",reason:"checked"})).rejects.toThrow("GOVERNANCE_VERSION_CONFLICT");
  expect((await db.query("SELECT status FROM agent_market.governance_proposals")).rows[0]).toEqual({status:"pending"});
});
it("publishes only approved snapshot, restores release, and protects participant tickets", async () => {
  const s = await setup();
  const p = await command(s, owner, {action:"propose_release",targetId:agent,expectedVersion:1,reason:"ready"});
  await command(s, reviewer, {action:"review",targetId:p.id,decision:"approve",reason:"checked"});
  await db.query("UPDATE agent_market.agents SET name='changed',version=3 WHERE id=$1",[agent]);
  const rollback = await command(s, operator, {action:"propose_rollback",targetId:agent,expectedVersion:3,releaseId:p.id,reason:"regression"});
  await command(s, reviewer, {action:"review",targetId:rollback.id,decision:"approve",reason:"checked"});
  expect((await db.query("SELECT name,status,version FROM agent_market.agents")).rows[0]).toEqual({name:"test",status:"published",version:4});
  await expect(command(s, `0x${"4".repeat(40)}`, {action:"open_ticket",targetId:task,reason:"help"})).rejects.toThrow("GOVERNANCE_FORBIDDEN");
  const ticket = await command(s, owner, {action:"open_ticket",targetId:task,reason:"help"});
  const close = await command(s, operator, {action:"resolve_ticket",targetId:ticket.id,expectedVersion:1,reason:"resolved"});
  await command(s, reviewer, {action:"review",targetId:close.id,decision:"approve",reason:"checked"});
  expect((await s.read(owner, "tickets"))[0]?.status).toBe("resolved");
  await expect(s.read(owner,"audit")).rejects.toThrow("GOVERNANCE_FORBIDDEN");
});
it("scans read-only, records severity and rejects client-supplied authority", async () => {
  const s = await setup();
  await expect(command(s,operator,{action:"event",severity:"P0",reason:"incident",reviewer:true})).rejects.toThrow("GOVERNANCE_INPUT_INVALID");
  await command(s,operator,{action:"event",severity:"P0",reason:"incident"});
  expect((await s.read(reviewer,"events"))[0]?.severity).toBe("P0");
  const before = await db.query("SELECT count(*) FROM agent_market.governance_audit");
  await s.read(operator,"compensation");
  expect((await db.query("SELECT count(*) FROM agent_market.governance_audit")).rows).toEqual(before.rows);
});
