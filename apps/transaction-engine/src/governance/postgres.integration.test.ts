import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeEach, expect, it } from "vitest";
import { GovernanceService } from "./service";
import { database } from "./runtime";

// This suite only accepts the explicitly dedicated local database.
const url = process.env.GOVERNANCE_TEST_DATABASE_URL;
const integration = url ? it : it.skip;
const sql = url ? postgres(url, { max: 5, prepare: false, onnotice:()=>{} }) : undefined;
const operator = `0x${"5".repeat(40)}`, reviewer = `0x${"6".repeat(40)}`;
const task = "33333333-3333-4333-8333-333333333333";
let service: GovernanceService;
beforeEach(async () => {
  if (!sql || !url) return;
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55439" || parsed.pathname !== "/am_governance_test") throw new Error("UNSAFE_TEST_DATABASE");
  await sql.unsafe("DROP SCHEMA IF EXISTS agent_market CASCADE");
  for (const name of ["0001_agent_market_core.sql", "0011_l2_orders.sql", "0021_governance.sql"]) {
    const source = readFileSync(new URL(`../../../../database/migrations/${name}`, import.meta.url), "utf8")
      .replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace("embedding vector(384)", "embedding double precision[]")
      .replace(/^BEGIN;$/gmu, "").replace(/^COMMIT;$/gmu, "");
    await sql.begin(tx => tx.unsafe(source));
  }
  await sql`INSERT INTO agent_market.governance_roles(wallet,role,granted_by,reason)
    VALUES (${operator},'operator','bootstrap','local integration'),(${reviewer},'reviewer','bootstrap','local integration')`;
  await sql`INSERT INTO agent_market.tasks(id,publisher_wallet,title,description,budget_atomic,status,request_id)
    VALUES (${task},${operator},'integration','integration',100,'in_progress',${task})`;
  service = new GovernanceService(database(sql));
});
afterAll(async () => { await sql?.end(); });
integration("UI contract returns DB permissions and current review target state without granting write authority",async()=>{
  await service.execute(operator,"ui-halt-key",crypto.randomUUID(),{action:"halt",targetId:task,expectedVersion:1,reason:"incident"});
  const p=await service.execute(operator,"ui-resume-key",crypto.randomUUID(),{action:"resume",targetId:task,expectedVersion:2,reason:"ready"});
  const view=await service.readView(reviewer,"reviews");
  expect(view.permissions).toEqual({walletAddress:reviewer,operator:false,reviewer:true,source:"agent_market.governance_roles"});
  expect(view.items[0]).toMatchObject({id:p.id,status:"pending",review_context:{targetId:task,from:"manual_review",to:"in_progress",version:2,expectedVersion:2,releaseId:null,restoredReleaseId:null}});
  await sql!`UPDATE agent_market.governance_roles SET revoked_at=now() WHERE wallet=${reviewer}`;
  const revoked=await service.readView(reviewer,"reviews");
  expect(revoked.permissions).toMatchObject({operator:false,reviewer:false});expect(revoked.items).toEqual([]);
  await expect(service.readView(reviewer,"audit")).rejects.toThrow("GOVERNANCE_FORBIDDEN");
});
integration("PostgreSQL serializes duplicate halt, conflicting payload and distinct concurrent reviewers", async () => {
  const input = {action:"halt",targetId:task,expectedVersion:1,reason:"incident"};
  const results = await Promise.all(Array.from({length:6},()=>service.execute(operator,"concurrent-halt",crypto.randomUUID(),input)));
  for (const result of results) expect(result).toEqual(results[0]);
  expect((await sql!`SELECT version FROM agent_market.tasks WHERE id=${task}`)[0]?.version).toBe(2);
  expect((await sql!`SELECT count(*)::int AS n FROM agent_market.governance_audit`)[0]?.n).toBe(1);
  await expect(service.execute(operator,"concurrent-halt",crypto.randomUUID(),{...input,reason:"different"})).rejects.toThrow("GOVERNANCE_IDEMPOTENCY_CONFLICT");
  const proposal = await service.execute(operator,"resume-proposal",crypto.randomUUID(),{action:"resume",targetId:task,expectedVersion:2,reason:"recovered"});
  const reviews = await Promise.allSettled(["review-key-01","review-key-02"].map(key=>service.execute(reviewer,key,crypto.randomUUID(),{action:"review",targetId:proposal.id,decision:"approve",reason:"checked"})));
  expect(reviews.filter(x=>x.status==="fulfilled")).toHaveLength(1);
  expect(reviews.filter(x=>x.status==="rejected")).toHaveLength(1);
  expect((await sql!`SELECT status,version FROM agent_market.tasks WHERE id=${task}`)[0]).toMatchObject({status:"in_progress",version:3});
  expect((await sql!`SELECT count(*)::int AS n FROM agent_market.governance_audit`)[0]?.n).toBe(3);
});
integration("PostgreSQL persists approved release snapshots, rollback and ticket resolution", async () => {
  const agent="44444444-4444-4444-8444-444444444444";
  await sql!`INSERT INTO agent_market.agents(id,owner_wallet,name,description,capabilities,status)
    VALUES (${agent},${operator},'original','description',ARRAY['code'],'draft')`;
  const release=await service.execute(operator,"release-proposal",crypto.randomUUID(),{action:"propose_release",targetId:agent,expectedVersion:1,reason:"ready"});
  await service.execute(reviewer,"release-review",crypto.randomUUID(),{action:"review",targetId:release.id,decision:"approve",reason:"checked"});
  await sql!`UPDATE agent_market.agents SET name='changed',version=3 WHERE id=${agent}`;
  const rollback=await service.execute(operator,"rollback-proposal",crypto.randomUUID(),{action:"propose_rollback",targetId:agent,expectedVersion:3,releaseId:release.id,reason:"regression"});
  const rolledBack=await service.execute(reviewer,"rollback-review",crypto.randomUUID(),{action:"review",targetId:rollback.id,decision:"approve",reason:"checked"});
  expect(rolledBack.effect).toMatchObject({targetId:agent,previousVersion:3,version:4,releaseId:rollback.id,restoredReleaseId:release.id});
  const [rollbackAudit]=await sql!`SELECT result,actor_wallet,authority FROM agent_market.governance_audit WHERE result->>'id'=${String(rollback.id)} AND action='review'`;
  expect(rollbackAudit?.result.effect).toEqual(rolledBack.effect);
  expect(rollbackAudit?.actor_wallet).toBe(reviewer);
  expect(rollbackAudit?.authority.source).toBe("agent_market.governance_roles");
  expect((await sql!`SELECT name,status,capabilities,version FROM agent_market.agents WHERE id=${agent}`)[0]).toMatchObject({name:"original",status:"published",capabilities:["code"],version:4});
  const ticket=await service.execute(operator,"ticket-open-key",crypto.randomUUID(),{action:"open_ticket",targetId:task,reason:"help"});
  const resolve=await service.execute(operator,"ticket-close-key",crypto.randomUUID(),{action:"resolve_ticket",targetId:ticket.id,expectedVersion:1,reason:"resolved"});
  await service.execute(reviewer,"ticket-review-key",crypto.randomUUID(),{action:"review",targetId:resolve.id,decision:"approve",reason:"checked"});
  expect((await service.read(operator,"tickets"))[0]?.status).toBe("resolved");
});
integration("PostgreSQL rolls back business state when audit insertion fails and denies revoked reviewer", async () => {
  await sql!.unsafe(`CREATE FUNCTION agent_market.fail_governance_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_AUDIT_FAILURE'; END $$;
    CREATE TRIGGER fail_governance_test_audit BEFORE INSERT ON agent_market.governance_audit FOR EACH ROW EXECUTE FUNCTION agent_market.fail_governance_test_audit()`);
  try {
    await expect(service.execute(operator,"rollback-halt-01",crypto.randomUUID(),{action:"halt",targetId:task,expectedVersion:1,reason:"rollback"})).rejects.toThrow("TEST_AUDIT_FAILURE");
    expect((await sql!`SELECT status,version FROM agent_market.tasks WHERE id=${task}`)[0]).toMatchObject({status:"in_progress",version:1});
    expect((await sql!`SELECT * FROM agent_market.governance_idempotency WHERE idempotency_key='rollback-halt-01'`)).toHaveLength(0);
  } finally {
    await sql!.unsafe("DROP TRIGGER fail_governance_test_audit ON agent_market.governance_audit; DROP FUNCTION agent_market.fail_governance_test_audit()");
  }
  await sql!`UPDATE agent_market.governance_roles SET revoked_at=now() WHERE wallet=${reviewer}`;
  await expect(service.execute(reviewer,"revoked-review",crypto.randomUUID(),{action:"review",targetId:task,decision:"approve",reason:"denied"})).rejects.toThrow("GOVERNANCE_FORBIDDEN");
  await service.execute(operator,"event-for-audit",crypto.randomUUID(),{action:"event",severity:"P1",reason:"audit"});
  await expect(sql!.unsafe("UPDATE agent_market.governance_audit SET action='tampered'")).rejects.toThrow("GOVERNANCE_AUDIT_IMMUTABLE");
});
integration("W4 revoked DB roles deny cached operator and reviewer actions immediately",async()=>{
  const event={action:"event",severity:"P1",reason:"incident"};
  await service.execute(operator,"revocable-event",crypto.randomUUID(),event);
  await service.execute(operator,"halt-for-revoke",crypto.randomUUID(),{action:"halt",targetId:task,expectedVersion:1,reason:"incident"});
  const p=await service.execute(operator,"resume-for-revoke",crypto.randomUUID(),{action:"resume",targetId:task,expectedVersion:2,reason:"ready"});
  const review={action:"review",targetId:p.id,decision:"approve",reason:"checked"};
  await service.execute(reviewer,"revocable-review",crypto.randomUUID(),review);
  await sql!`UPDATE agent_market.governance_roles SET revoked_at=now()`;
  await expect(service.execute(operator,"revocable-event",crypto.randomUUID(),event)).rejects.toThrow("GOVERNANCE_FORBIDDEN");
  await expect(service.execute(reviewer,"revocable-review",crypto.randomUUID(),review)).rejects.toThrow("GOVERNANCE_FORBIDDEN");
  await expect(service.read(reviewer,"audit")).rejects.toThrow("GOVERNANCE_FORBIDDEN");
});
integration("W4 new manual_review takes precedence over an old successful resume replay",async()=>{
  await service.execute(operator,"halt-cycle-one",crypto.randomUUID(),{action:"halt",targetId:task,expectedVersion:1,reason:"incident"});
  const resume={action:"resume",targetId:task,expectedVersion:2,reason:"ready"};
  const p=await service.execute(operator,"resume-cycle-one",crypto.randomUUID(),resume);
  const review={action:"review",targetId:p.id,decision:"approve",reason:"checked"};
  const approved=await service.execute(reviewer,"review-cycle-one",crypto.randomUUID(),review);
  expect(approved.effect).toMatchObject({targetId:task,from:"manual_review",to:"in_progress",previousVersion:2,version:3});
  await service.execute(operator,"halt-cycle-two",crypto.randomUUID(),{action:"halt",targetId:task,expectedVersion:3,reason:"new incident"});
  await expect(service.execute(reviewer,"review-cycle-one",crypto.randomUUID(),review)).rejects.toThrow("GOVERNANCE_MANUAL_REVIEW_REQUIRED");
  await expect(service.execute(operator,"resume-cycle-one",crypto.randomUUID(),resume)).rejects.toThrow("GOVERNANCE_MANUAL_REVIEW_REQUIRED");
  const [audit]=await sql!`SELECT result,authority FROM agent_market.governance_audit WHERE action='review'`;
  expect(audit?.result.effect).toEqual(approved.effect);
  expect(audit?.authority).toMatchObject({source:"agent_market.governance_roles",grants:[{role:"reviewer",granted_by:"bootstrap"}]});
  expect((await sql!`SELECT status,version FROM agent_market.tasks WHERE id=${task}`)[0]).toMatchObject({status:"manual_review",version:4});
});
integration("W4 reviewer grants never permit self review or owner review of an operator release",async()=>{
  const agent="55555555-5555-4555-8555-555555555555";
  await sql!`INSERT INTO agent_market.governance_roles(wallet,role,granted_by,reason) VALUES(${operator},'reviewer','bootstrap','dual role')`;
  await sql!`INSERT INTO agent_market.agents(id,owner_wallet,name,description,capabilities,status) VALUES(${agent},${reviewer},'agent','description',ARRAY['code'],'draft')`;
  const p=await service.execute(operator,"independent-release",crypto.randomUUID(),{action:"propose_release",targetId:agent,expectedVersion:1,reason:"ready"});
  for (const actor of [operator,reviewer]) {
    await expect(service.execute(actor,"independent-review",crypto.randomUUID(),{action:"review",targetId:p.id,decision:"approve",reason:"self"})).rejects.toThrow("GOVERNANCE_SELF_REVIEW");
  }
  expect((await sql!`SELECT status FROM agent_market.governance_proposals WHERE id=${String(p.id)}`)[0]?.status).toBe("pending");
  expect((await sql!`SELECT count(*)::int AS n FROM agent_market.governance_audit`)[0]?.n).toBe(1);
});
