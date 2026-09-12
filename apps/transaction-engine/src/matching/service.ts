import { randomUUID } from "node:crypto";
import { id } from "ethers";
import type { Sql } from "postgres";
import { VrfBindingAdapter, type VrfBindingConfig, type VrfBindingInput, type VrfCallback } from "../chain/vrf-selection-binding";
import { SqlVrfBindingStore, type VrfSqlClient } from "../chain/vrf-selection-binding-store";
import type { VrfOracleReader } from "./oracle-reader";

type Row = Record<string, unknown>;
type Query = <T extends Row = Row>(sql: string, params?: unknown[]) => Promise<T[]>;
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
export type MatchingCommand = { mode: "ranked" | "vrf-exploration"; expectedVersion: number };
export function parseMatchingCommand(value: unknown): MatchingCommand {
  const b = value as Partial<MatchingCommand> | null;
  if (!b || Object.keys(b).some((k) => !["mode", "expectedVersion"].includes(k))
    || !["ranked", "vrf-exploration"].includes(b.mode ?? "") || !Number.isSafeInteger(b.expectedVersion) || b.expectedVersion! < 1)
    throw new Error("MATCH_INPUT_INVALID");
  return b as MatchingCommand;
}
export class MatchingService {
  constructor(private readonly sql: Sql, private readonly config: VrfBindingConfig | null,
    private readonly oracle: VrfOracleReader | null = null, private readonly evidenceSql: Sql | null = null) {}
  private async transaction<T>(actor: string, work: (q: Query, client: VrfSqlClient) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      const q: Query = async <R extends Row>(sql: string, params: unknown[] = []) => {
        // postgres.js serializes JSONB parameters itself; the generic SQL port uses JSON text.
        const encoded = params.map((value, index) => typeof value === "string"
          && sql.includes(`$${index + 1}::jsonb`) ? JSON.parse(value) : value);
        return await tx.unsafe(sql, encoded as never[]) as unknown as R[];
      };
      await q("SELECT set_config('agent_market.match_actor',$1,true)", [actor.toLowerCase()]);
      return work(q, { query: async <R>(sql: string, params?: unknown[]) => ({ rows: await q(sql, params) as R[] }) });
    }) as Promise<T>;
  }
  private async lock(q: Query, taskId: string, actor: string) {
    await q("SELECT pg_advisory_xact_lock(hashtextextended($1,240024))", [taskId]);
    const [t] = await q("SELECT *, budget_atomic::text AS budget_text FROM agent_market.tasks WHERE id=$1 FOR UPDATE", [taskId]);
    if (!t || String(t.publisher_wallet).toLowerCase() !== actor.toLowerCase()) throw new Error("MATCH_FORBIDDEN");
    if (t.status !== "matching" || t.agent_id !== null) throw new Error("MATCH_TASK_LOCKED");
    const [w] = await q("SELECT agent_market.vrf_workflow_stamp($1) AS stamp", [taskId]);
    const stamp = w!.stamp as Row;
    const snapshot = stamp.snapshot as Row | undefined;
    if (snapshot && (snapshot.graphConfirmedRevision != null || snapshot.runId != null)) throw new Error("MATCH_TASK_LOCKED");
    return { t, stamp };
  }
  async configure(actor: string, taskId: string, raw: unknown) {
    taskId = taskId.toLowerCase();
    const command = parseMatchingCommand(raw);
    if (command.mode === "vrf-exploration" && !this.config) throw new Error("VRF_CONFIG_UNAVAILABLE");
    return this.transaction(actor, async (q, client) => {
      const { t, stamp } = await this.lock(q, taskId, actor);
      if (Number(t.version) !== command.expectedVersion) throw new Error("MATCH_VERSION_CONFLICT");
      const existing = await q(`SELECT 1 FROM agent_market.vrf_selection_intents WHERE task_id=$1
        UNION ALL SELECT 1 FROM agent_market.match_candidates WHERE request_id=$2
        UNION ALL SELECT 1 FROM agent_market.consumed_events WHERE request_id=$2 AND consumer='matcher-go'`, [taskId, t.request_id]);
      if (existing.length) throw new Error("VRF_REROLL_FORBIDDEN");
      const [clock] = await q("SELECT revision::text FROM agent_market.vrf_qualification_clock WHERE singleton FOR SHARE");
      const qualificationRevision = Number(clock!.revision);
      if (!Number.isSafeInteger(qualificationRevision)) throw new Error("QUALIFICATION_REVISION_INVALID");
      // No asynchronous oracle call or browser candidate list enters this locked snapshot.
      const modelVersion = command.mode === "vrf-exploration" ? "vrf-qualified-equal-v1" : "baseline-v1";
      const matchJobId = randomUUID(), eventId = randomUUID();
      let input: VrfBindingInput | null = null;
      let bindingKey: string | null = null;
      await q("UPDATE agent_market.tasks SET selection_mode=$2,version=version+1 WHERE id=$1", [taskId, command.mode]);
      if (command.mode === "vrf-exploration") {
        const candidates = await q(`WITH eligible AS (
          SELECT a.id::text AS agent_id,a.version,COALESCE(NULLIF(lower(a.model_tag),''),a.id::text) AS model,
            a.selection_access,a.owner_wallet,a.capabilities,a.categories,a.tags,a.available,
            a.minimum_budget_atomic::text AS minimum_budget,a.embedding::text AS embedding,
            row_number() OVER (PARTITION BY COALESCE(NULLIF(lower(a.model_tag),''),a.id::text)
              ORDER BY a.embedding <=> t.embedding,a.id) AS model_rank
          FROM agent_market.agents a JOIN agent_market.tasks t ON t.id=$1
          WHERE a.status='active' AND a.available=TRUE AND a.embedding IS NOT NULL AND vector_norm(a.embedding)>0
            AND t.embedding IS NOT NULL AND vector_norm(t.embedding)>0
            AND a.capabilities @> t.requirements AND (t.category='' OR t.category=ANY(a.categories))
            AND a.tags @> t.tags AND t.budget_atomic>=a.minimum_budget_atomic
            AND (a.selection_access='public-market' OR lower(a.owner_wallet)=lower(t.publisher_wallet))
        ) SELECT * FROM eligible WHERE model_rank=1 ORDER BY agent_id LIMIT 129`, [taskId]);
        if (!candidates.length || candidates.length > 128) throw new Error("VRF_QUALIFIED_POOL_INVALID");
        input = {
          task: { id: taskId, version: command.expectedVersion + 1, status: "matching" },
          match: { taskId, eventId, requestId: String(t.request_id), matchJobId, modelVersion },
          pool: { taskId, taskRevision: command.expectedVersion + 1, revision: qualificationRevision,
            policyVersion: "qualified-equal-v1", modelVersion,
            evidenceDigest: id(JSON.stringify({ task: json(t), workflow: stamp, candidates, qualificationRevision })),
            candidates: candidates.map((c) => ({ agentId: String(c.agent_id), weight: 1 })) },
        };
        const adapter = new VrfBindingAdapter(this.config!, new SqlVrfBindingStore(client));
        bindingKey = (await adapter.freeze(input)).taskKey;
      }
      await q(`INSERT INTO agent_market.vrf_selection_intents
        (task_id,mode,task_version,request_id,match_job_id,event_id,model_version,qualification_revision,workflow_stamp,input_snapshot,binding_key,configured_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
      [taskId,command.mode,command.expectedVersion+1,t.request_id,matchJobId,eventId,modelVersion,qualificationRevision,JSON.stringify(stamp),JSON.stringify(input ?? {}),bindingKey,actor.toLowerCase()]);
      // Existing matcher event contract and existing outbox, no new queue/service.
      const event = { eventId, type: "match.requested.v1", occurredAt: new Date().toISOString(),
        requestId: String(t.request_id), matchJobId, taskId, modelVersion };
      await q(`INSERT INTO agent_market.outbox_events(id,aggregate_type,aggregate_id,event_type,request_id,topic,payload)
        VALUES($1,'task',$2,'match.requested.v1',$3,'match.requested.v1',$4::jsonb)`, [eventId,taskId,t.request_id,JSON.stringify(event)]);
      return { mode: command.mode, status: command.mode === "ranked" ? "queued" : "oracle_pending", taskVersion: command.expectedVersion+1, event,
        ...(input ? await new VrfBindingAdapter(this.config!,new SqlVrfBindingStore(client)).view(input) : {}) };
    });
  }
  async setAccess(actor: string, agentId: string, value: unknown) {
    const b = value as { access?: string; expectedVersion?: number } | null;
    if (!b || Object.keys(b).some((k) => !["access","expectedVersion"].includes(k))
      || !["owner-only","public-market"].includes(b.access ?? "") || !Number.isSafeInteger(b.expectedVersion)) throw new Error("MATCH_INPUT_INVALID");
    return this.transaction(actor, async (q) => {
      // Same qualifier->agent order as the qualification statement trigger.
      await q("SELECT revision FROM agent_market.vrf_qualification_clock WHERE singleton FOR UPDATE");
      const [a] = await q("SELECT owner_wallet,version FROM agent_market.agents WHERE id=$1 FOR UPDATE",[agentId]);
      if (!a || String(a.owner_wallet).toLowerCase()!==actor.toLowerCase()) throw new Error("MATCH_FORBIDDEN");
      if (a.version!==b.expectedVersion) throw new Error("MATCH_VERSION_CONFLICT");
      const [updated] = await q("UPDATE agent_market.agents SET selection_access=$2,version=version+1 WHERE id=$1 RETURNING version,selection_access",[agentId,b.access]);
      return updated;
    });
  }
  async status(actor: string, taskId: string) {
    taskId = taskId.toLowerCase();
    return this.readStatus(actor,taskId,false);
  }
  async refresh(actor: string, taskId: string) {
    taskId = taskId.toLowerCase();
    let oracleUnavailable=false;
    if (this.oracle) {
      try { await this.refreshFromOracle(actor,taskId); }
      catch(error) {
        if(error instanceof Error && /FORBIDDEN|TASK_LOCKED|BINDING_STALE/u.test(error.message))throw error;
        oracleUnavailable=true;
      }
    }
    return this.readStatus(actor,taskId,oracleUnavailable);
  }
  private async readStatus(actor: string, taskId: string, oracleUnavailable: boolean) {
    return this.transaction(actor, async (q,client) => {
      const {t} = await this.lock(q,taskId,actor);
      if (t.selection_mode === "ranked") return { mode: "ranked", status: "ranked", taskVersion: Number(t.version) };
      const [intent] = await q("SELECT * FROM agent_market.vrf_selection_intents WHERE task_id=$1",[taskId]);
      if (!intent || !this.config) throw new Error("VRF_CONFIG_UNAVAILABLE");
      const [gate] = await q("SELECT agent_market.vrf_match_gate($1,$2,$3,$4) AS status",[taskId,intent.request_id,intent.match_job_id,intent.model_version]);
      if (gate!.status === "binding_stale") return { mode: "vrf-exploration", status: "binding_stale", fairnessVerified: false, selectedAgentId: null };
      if (String(gate!.status).startsWith("verified:")) {
        const [proof] = await q("SELECT evidence,agent_id FROM agent_market.vrf_verified_selections WHERE task_id=$1",[taskId]);
        return {mode:"vrf-exploration",status:"verified",fairnessVerified:true,selectedAgentId:proof!.agent_id,evidence:proof!.evidence};
      }
      return { mode: "vrf-exploration", ...await new VrfBindingAdapter(this.config,new SqlVrfBindingStore(client)).view(intent.input_snapshot as VrfBindingInput),
        ...(oracleUnavailable ? {pendingReason:"oracle-unavailable"} : {}) };
    });
  }
  /** External read happens outside the SQL transaction; authoritative revisions are locked again on apply. */
  private async refreshFromOracle(actor: string, taskId: string) {
    if (!this.oracle || !this.config) return;
    const pending = await this.transaction(actor,async(q,client)=>{
      const {t}=await this.lock(q,taskId,actor);
      if(t.selection_mode!=="vrf-exploration")return null;
      const [intent]=await q("SELECT * FROM agent_market.vrf_selection_intents WHERE task_id=$1",[taskId]);
      if(!intent)throw new Error("VRF_BINDING_MISSING");
      const [gate]=await q("SELECT agent_market.vrf_match_gate($1,$2,$3,$4) AS status",[taskId,intent.request_id,intent.match_job_id,intent.model_version]);
      if(gate!.status!=="oracle_pending")return null;
      const store=new SqlVrfBindingStore(client);
      await new VrfBindingAdapter(this.config!,store).view(intent.input_snapshot as VrfBindingInput);
      return (await store.read(String(intent.binding_key)))!.record.binding;
    });
    if(!pending)return;
    const evidence=await this.oracle.read(pending);
    if(!evidence)return;
    if(evidence.taskKey!==pending.taskKey || evidence.commitment!==pending.commitment)throw new Error("VRF_ORACLE_BINDING_MISMATCH");
    const shouldRecord = await this.transaction(actor,async(q,client)=>{
      await this.lock(q,taskId,actor);
      const [intent]=await q("SELECT * FROM agent_market.vrf_selection_intents WHERE task_id=$1",[taskId]);
      const [gate]=await q("SELECT agent_market.vrf_match_gate($1,$2,$3,$4) AS status",[taskId,intent!.request_id,intent!.match_job_id,intent!.model_version]);
      if(String(gate!.status).startsWith("verified:"))return false;
      if(gate!.status!=="oracle_pending")throw new Error("VRF_BINDING_STALE");
      const store=new SqlVrfBindingStore(client);
      const record=(await store.read(String(intent!.binding_key)))!.record;
      if(record.binding.commitment!==evidence.commitment)throw new Error("VRF_ORACLE_BINDING_MISMATCH");
      if(record.phase==="awaiting_request")await new VrfBindingAdapter(this.config!,store).bindRequest(intent!.input_snapshot as VrfBindingInput,evidence.requestId);
      else if(record.requestId!==evidence.requestId)throw new Error("VRF_ORACLE_REQUEST_MISMATCH");
      return true;
    });
    if (!shouldRecord) return;
    if (!this.evidenceSql) throw new Error("VRF_EVIDENCE_WRITER_UNAVAILABLE");
    await this.evidenceSql.unsafe("SELECT agent_market.vrf_record_verified_selection($1,$2,$3,$4,$5::jsonb)",
      [taskId,pending.taskKey,evidence.agentId,`${pending.chainId}:${pending.selectorAddress}:${evidence.requestId}`,
        this.evidenceSql.json({ ...evidence })]);
  }
  /** Internal reader hook only: current task/workflow/qualification are re-locked, never accepted from callback JSON. */
  async observe(actor: string, taskId: string, requestId: string, callback?: VrfCallback) {
    taskId = taskId.toLowerCase();
    if (!this.config) throw new Error("VRF_CONFIG_UNAVAILABLE");
    return this.transaction(actor, async (q,client) => {
      await this.lock(q,taskId,actor);
      const [intent] = await q("SELECT * FROM agent_market.vrf_selection_intents WHERE task_id=$1",[taskId]);
      if (!intent || intent.mode!=="vrf-exploration") throw new Error("VRF_BINDING_MISSING");
      const [gate] = await q("SELECT agent_market.vrf_match_gate($1,$2,$3,$4) AS status",[taskId,intent.request_id,intent.match_job_id,intent.model_version]);
      if (gate!.status!=="oracle_pending") throw new Error("VRF_BINDING_STALE");
      const adapter = new VrfBindingAdapter(this.config!,new SqlVrfBindingStore(client));
      const input = intent.input_snapshot as VrfBindingInput;
      if (callback) await adapter.recordCallback(input,callback);
      else await adapter.bindRequest(input,requestId);
      return adapter.view(input);
    });
  }
}
