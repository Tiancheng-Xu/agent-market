import { createHash, randomUUID } from "node:crypto";
import { validate as isUuid } from "uuid";

export type Row = Record<string, unknown>;
export interface Database {
  query(sql: string, values?: unknown[]): Promise<Row[]>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}
export class GovernanceError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const fail = (code: string, status = 409): never => { throw new GovernanceError(`GOVERNANCE_${code}`,status); };
const canonical = (v: unknown): string => {
  if (v && typeof v === "object" && !Array.isArray(v)) return `{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return JSON.stringify(v);
};
const keys: Record<string,string[]> = {
  event:["severity"], open_ticket:["targetId"], halt:["targetId","expectedVersion"],
  resume:["targetId","expectedVersion"], propose_release:["targetId","expectedVersion"],
  propose_rollback:["targetId","expectedVersion","releaseId"], resolve_ticket:["targetId","expectedVersion"],
  review:["targetId","decision"],
};
export function parseCommand(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("INPUT_INVALID",400);
  const body = value as Row, action = String(body.action);
  const allowed = keys[action];
  if (!allowed || Object.keys(body).some(k=>!["action","reason",...allowed].includes(k))
      || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length>2000) return fail("INPUT_INVALID",400);
  for (const key of allowed) {
    if (key.endsWith("Id") && (typeof body[key] !== "string" || !isUuid(body[key]))) return fail("INPUT_INVALID",400);
    if (key === "expectedVersion" && (!Number.isSafeInteger(body[key]) || Number(body[key])<1)) return fail("INPUT_INVALID",400);
  }
  if (action === "event" && !["P0","P1","P2","P3"].includes(String(body.severity))) return fail("INPUT_INVALID",400);
  if (action === "review" && !["approve","reject"].includes(String(body.decision))) return fail("INPUT_INVALID",400);
  return body;
}
async function roles(tx: Database, wallet: string) {
  return tx.query("SELECT role,granted_by,granted_at,reason FROM agent_market.governance_roles WHERE wallet=$1 AND revoked_at IS NULL FOR SHARE",[wallet]);
}
const has = (r: Row[], role: string) => r.some(x=>x.role===role);
const requireRole = (r: Row[], role: string) => { if (!has(r,role)) fail("FORBIDDEN",403); };
async function target(tx: Database, table: "tasks"|"agents"|"governance_tickets", id: unknown) {
  const [row] = await tx.query(`SELECT * FROM agent_market.${table} WHERE id=$1 FOR UPDATE`,[id]);
  if (!row) return fail("NOT_FOUND",404);
  return row;
}
function version(row: Row, expected: unknown) { if (row.version!==expected) fail("VERSION_CONFLICT"); }
function snapshot(agent: Row): Row {
  return {name:agent.name,description:agent.description,capabilities:agent.capabilities,endpoint_url:agent.endpoint_url,owner_wallet:agent.owner_wallet};
}
function releaseGate(agent: Row) {
  if (!["draft","reviewing","paused","published"].includes(String(agent.status))
      || !String(agent.name).trim() || !String(agent.description).trim()
      || !Array.isArray(agent.capabilities) || !agent.capabilities.length) fail("RELEASE_GATE_FAILED");
}
async function participant(tx: Database, taskId: unknown, wallet: string) {
  const [row] = await tx.query(`SELECT t.id FROM agent_market.tasks t LEFT JOIN agent_market.agents a ON a.id=t.agent_id
    WHERE t.id=$1 AND (lower(t.publisher_wallet)=$2 OR lower(a.owner_wallet)=$2)`,[taskId,wallet]);
  if (!row) fail("FORBIDDEN",403);
}
export class GovernanceService {
  constructor(private readonly db: Database) {}
  async execute(rawWallet: string, key: string, requestId: string, input: unknown): Promise<Row> {
    const wallet=rawWallet.toLowerCase(), body=parseCommand(input);
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || !isUuid(requestId) || key.length<8 || key.length>160) return fail("INPUT_INVALID",400);
    const fingerprint=createHash("sha256").update(canonical(body)).digest("hex");
    return this.db.transaction(async tx=> {
      // Transaction-scoped lock serializes retries across processes, before any side effects.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${wallet}:${key}`]);
      const authority=await roles(tx,wallet);
      // Authorization is current DB state, including for an idempotent retry.
      await this.authorize(tx,wallet,authority,body);
      const [cached]=await tx.query("SELECT fingerprint,result FROM agent_market.governance_idempotency WHERE actor_wallet=$1 AND idempotency_key=$2",[wallet,key]);
      if (cached) {
        if (cached.fingerprint!==fingerprint) return fail("IDEMPOTENCY_CONFLICT");
        await this.checkReplayState(tx,body,cached.result as Row);
        return cached.result as Row;
      }
      const result=await this.mutate(tx,wallet,authority,body,requestId);
      await tx.query("INSERT INTO agent_market.governance_audit(request_id,actor_wallet,action,result,authority) VALUES($1,$2,$3,$4::text::jsonb,$5::text::jsonb)",[requestId,wallet,body.action,JSON.stringify({...result,reason:body.reason}),JSON.stringify({source:"agent_market.governance_roles",grants:authority})]);
      await tx.query("INSERT INTO agent_market.governance_idempotency(actor_wallet,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4::text::jsonb)",[wallet,key,fingerprint,JSON.stringify(result)]);
      return result;
    });
  }
  private async authorize(tx: Database,wallet: string,authority: Row[],b: Row) {
    if (b.action==="open_ticket") return participant(tx,b.targetId,wallet);
    if (b.action==="propose_release") {
      const agent=await target(tx,"agents",b.targetId);
      if (String(agent.owner_wallet).toLowerCase()!==wallet) requireRole(authority,"operator");
      return;
    }
    if (b.action==="review") {
      requireRole(authority,"reviewer");
      const [p]=await tx.query("SELECT * FROM agent_market.governance_proposals WHERE id=$1 FOR UPDATE",[b.targetId]);
      if (!p) return fail("NOT_FOUND",404);
      if (String(p.proposer_wallet).toLowerCase()===wallet) return fail("SELF_REVIEW",403);
      if (p.kind==="propose_release" || p.kind==="propose_rollback") {
        const agent=await target(tx,"agents",p.target_id);
        if (String(agent.owner_wallet).toLowerCase()===wallet || String((p.payload as Row).owner_wallet).toLowerCase()===wallet) return fail("SELF_REVIEW",403);
      }
      return;
    }
    requireRole(authority,"operator");
  }
  private async checkReplayState(tx: Database,b: Row,result: Row) {
    if (b.action==="halt" || b.action==="resume") {
      const task=await target(tx,"tasks",b.targetId);
      const expected=b.action==="halt" ? result.version : b.expectedVersion;
      if (task.status==="manual_review" && task.version!==expected) return fail("MANUAL_REVIEW_REQUIRED");
      if (b.action==="halt" && task.status!=="manual_review") return fail("VERSION_CONFLICT");
    }
    if (b.action==="review") {
      const [p]=await tx.query("SELECT * FROM agent_market.governance_proposals WHERE id=$1 FOR UPDATE",[b.targetId]);
      if (p?.kind==="resume" && result.status==="approved") {
        const task=await target(tx,"tasks",p.target_id);
        if (task.status==="manual_review") return fail("MANUAL_REVIEW_REQUIRED");
      }
    }
  }
  private async mutate(tx: Database,wallet: string,authority: Row[],b: Row,requestId: string): Promise<Row> {
    const id=randomUUID(), action=String(b.action);
    if (action === "event") {
      requireRole(authority,"operator");
      await tx.query("INSERT INTO agent_market.governance_events(id,severity,reason,actor_wallet) VALUES($1,$2,$3,$4)",[id,b.severity,b.reason,wallet]);
      return {id,severity:b.severity,status:"recorded"};
    }
    if (action === "open_ticket") {
      await participant(tx,b.targetId,wallet);
      await tx.query("INSERT INTO agent_market.governance_tickets(id,task_id,opened_by,reason) VALUES($1,$2,$3,$4)",[id,b.targetId,wallet,b.reason]);
      return {id,status:"open",version:1};
    }
    if (action === "review") {
      requireRole(authority,"reviewer");
      const [p]=await tx.query("SELECT * FROM agent_market.governance_proposals WHERE id=$1 FOR UPDATE",[b.targetId]);
      if (!p) return fail("NOT_FOUND",404);
      if (p.proposer_wallet===wallet) return fail("SELF_REVIEW",403);
      if (p.status!=="pending") return fail("REVIEW_CONFLICT");
      const payload=p.payload as Row;
      if ((p.kind==="propose_release" || p.kind==="propose_rollback") && String(payload.owner_wallet).toLowerCase()===wallet) return fail("SELF_REVIEW",403);
      const effect=b.decision==="approve" ? await this.apply(tx,p,wallet,requestId) : undefined;
      const status=b.decision==="approve" ? "approved":"rejected";
      await tx.query("UPDATE agent_market.governance_proposals SET status=$2,reviewer_wallet=$3,review_reason=$4,reviewed_at=now() WHERE id=$1",[p.id,status,wallet,b.reason]);
      return {id:p.id,status,kind:p.kind,targetId:p.target_id,...(effect ? {effect} : {})};
    }
    let row: Row, payload: Row={};
    if (action === "halt" || action === "resume") {
      requireRole(authority,"operator"); row=await target(tx,"tasks",b.targetId); version(row,b.expectedVersion);
      if (action === "halt") {
        if (["settled","refunded","manual_review"].includes(String(row.status))) return fail("TRANSITION_INVALID");
        await tx.query("UPDATE agent_market.tasks SET manual_review_from_status=status,manual_review_reason_code=$2,status='manual_review',version=version+1,updated_at=now() WHERE id=$1",[b.targetId,b.reason]);
        await this.taskEvent(tx,b.targetId,requestId,wallet,"mark_manual_review",row.status,"manual_review");
        return {id:b.targetId,status:"manual_review",version:Number(row.version)+1};
      }
      if (row.status!=="manual_review" || !row.manual_review_from_status) return fail("TRANSITION_INVALID");
      payload={previousStatus:row.manual_review_from_status};
    } else if (action === "resolve_ticket") {
      requireRole(authority,"operator"); row=await target(tx,"governance_tickets",b.targetId); version(row,b.expectedVersion);
      if (row.status!=="open") return fail("TRANSITION_INVALID");
    } else {
      row=await target(tx,"agents",b.targetId); version(row,b.expectedVersion);
      if (String(row.owner_wallet).toLowerCase()!==wallet) requireRole(authority,"operator");
      releaseGate(row); payload=snapshot(row);
      if (action === "propose_rollback") {
        requireRole(authority,"operator");
        const [release]=await tx.query("SELECT snapshot FROM agent_market.governance_releases WHERE id=$1 AND agent_id=$2",[b.releaseId,b.targetId]);
        if (!release) return fail("RELEASE_NOT_FOUND",404);
        payload={...payload,restore:release.snapshot,releaseId:b.releaseId};
      }
    }
    await tx.query("INSERT INTO agent_market.governance_proposals(id,kind,target_id,expected_version,proposer_wallet,reason,payload) VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb)",[id,action,b.targetId,b.expectedVersion,wallet,b.reason,JSON.stringify(payload)]);
    return {id,status:"pending",kind:action,targetId:b.targetId,expectedVersion:b.expectedVersion};
  }
  private async apply(tx: Database,p: Row,wallet: string,requestId: string) {
    const payload=p.payload as Row;
    if (p.kind==="resume") {
      const row=await target(tx,"tasks",p.target_id); version(row,p.expected_version);
      if (row.status!=="manual_review" || row.manual_review_from_status!==payload.previousStatus) return fail("TRANSITION_INVALID");
      await tx.query("UPDATE agent_market.tasks SET status=manual_review_from_status,manual_review_from_status=NULL,manual_review_reason_code=NULL,version=version+1,updated_at=now() WHERE id=$1",[p.target_id]);
      await this.taskEvent(tx,p.target_id,requestId,wallet,"resume_manual_review","manual_review",payload.previousStatus);
      return {targetId:p.target_id,from:row.status,to:payload.previousStatus,previousVersion:row.version,version:Number(row.version)+1};
    } else if (p.kind==="resolve_ticket") {
      const row=await target(tx,"governance_tickets",p.target_id); version(row,p.expected_version);
      if (row.status!=="open") return fail("TRANSITION_INVALID");
      await tx.query("UPDATE agent_market.governance_tickets SET status='resolved',resolution=$2,version=version+1,updated_at=now() WHERE id=$1",[p.target_id,p.reason]);
      return {targetId:p.target_id,from:row.status,to:"resolved",previousVersion:row.version,version:Number(row.version)+1};
    } else {
      const row=await target(tx,"agents",p.target_id); version(row,p.expected_version); releaseGate(row);
      if (String(row.owner_wallet).toLowerCase()===wallet) return fail("SELF_REVIEW",403);
      const current=snapshot(row);
      const proposed={...payload}; delete proposed.restore; delete proposed.releaseId;
      if (canonical(current)!==canonical(proposed)) return fail("RELEASE_CONTENT_CONFLICT");
      const release=p.kind==="propose_rollback" ? payload.restore as Row : proposed;
      if (release.owner_wallet!==row.owner_wallet) return fail("RELEASE_OWNER_CONFLICT");
      await tx.query("UPDATE agent_market.agents SET name=$2,description=$3,capabilities=$4,endpoint_url=$5,status='published',version=version+1,updated_at=now() WHERE id=$1",[p.target_id,release.name,release.description,release.capabilities,release.endpoint_url]);
      await tx.query("INSERT INTO agent_market.governance_releases(id,agent_id,snapshot,published_version) VALUES($1,$2,$3::text::jsonb,$4)",[p.id,p.target_id,JSON.stringify(release),Number(row.version)+1]);
      return {targetId:p.target_id,from:row.status,to:"published",previousVersion:row.version,version:Number(row.version)+1,
        releaseId:p.id,...(p.kind==="propose_rollback" ? {restoredReleaseId:payload.releaseId} : {})};
    }
  }
  private async taskEvent(tx: Database,id: unknown,requestId: string,wallet: string,action: string,from: unknown,to: unknown) {
    await tx.query("INSERT INTO agent_market.task_events(task_id,request_id,event_type,actor_wallet,payload) VALUES($1,$2,$3,$4,$5::text::jsonb)",[id,requestId,action,wallet,JSON.stringify({from,to,source:"governance"})]);
  }
  async read(rawWallet: string,resource: string): Promise<Row[]> {
    return (await this.readView(rawWallet,resource)).items;
  }
  async readView(rawWallet: string,resource: string) {
    const wallet=rawWallet.toLowerCase();
    return this.db.transaction(async tx=> {
      const authority=await roles(tx,wallet), staff=has(authority,"operator")||has(authority,"reviewer");
      const items=await (async (): Promise<Row[]>=>{
      if (resource==="tickets") return tx.query(`SELECT k.* FROM agent_market.governance_tickets k JOIN agent_market.tasks t ON t.id=k.task_id
        LEFT JOIN agent_market.agents a ON a.id=t.agent_id WHERE $1::boolean OR lower(t.publisher_wallet)=$2 OR lower(a.owner_wallet)=$2 ORDER BY k.created_at DESC LIMIT 100`,[staff,wallet]);
      if (resource==="reviews") return tx.query(`SELECT p.*, jsonb_build_object(
        'targetId',p.target_id,'from',COALESCE(t.status,a.status,k.status),
        'to',CASE WHEN p.kind='resume' THEN p.payload->>'previousStatus' WHEN p.kind='resolve_ticket' THEN 'resolved' ELSE 'published' END,
        'version',COALESCE(t.version,a.version,k.version),'expectedVersion',p.expected_version,
        'releaseId',CASE WHEN a.id IS NOT NULL THEN p.id ELSE NULL END,
        'restoredReleaseId',p.payload->>'releaseId','ownerWallet',a.owner_wallet) AS review_context
        FROM agent_market.governance_proposals p
        LEFT JOIN agent_market.tasks t ON p.kind='resume' AND t.id=p.target_id
        LEFT JOIN agent_market.agents a ON p.kind IN ('propose_release','propose_rollback') AND a.id=p.target_id
        LEFT JOIN agent_market.governance_tickets k ON p.kind='resolve_ticket' AND k.id=p.target_id
        WHERE $1::boolean OR p.proposer_wallet=$2 ORDER BY p.created_at DESC LIMIT 100`,[staff,wallet]);
      if (!staff) return fail("FORBIDDEN",403);
      if (resource==="compensation") return tx.query(`SELECT id AS "targetId",status,version,
        CASE WHEN status='manual_review' THEN 'inspect_before_resume' ELSE 'inspect_chain_evidence_no_auto_replay' END AS recommendation,
        true AS "readOnly",false AS "cloudExecuted" FROM agent_market.tasks
        WHERE status IN ('manual_review','funding_pending','disputed') ORDER BY updated_at LIMIT 100`);
      if (resource==="events") return tx.query("SELECT * FROM agent_market.governance_events ORDER BY created_at DESC LIMIT 100");
      if (resource==="audit") return tx.query("SELECT * FROM agent_market.governance_audit ORDER BY id DESC LIMIT 100");
      return fail("NOT_FOUND",404);
      })();
      return {items,permissions:{walletAddress:wallet,operator:has(authority,"operator"),reviewer:has(authority,"reviewer"),source:"agent_market.governance_roles"}};
    });
  }
}
