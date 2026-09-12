import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { MatchingService } from "./service";
import type { VrfBindingInput } from "../chain/vrf-selection-binding";
import { prepareVrfBinding } from "../chain/vrf-selection-binding";
import type { VrfBinding } from "../chain/vrf-selection-binding";
import type { OracleSelectionEvidence } from "./oracle-reader";

const password = process.env.VRF_TEST_PASSWORD;
const url = new URL("postgres://postgres@127.0.0.1:55439/am_vrf_w6_test");
url.password = password ?? "";
const sql = password !== undefined ? postgres(url.toString(),{max:8,prepare:false,onnotice:()=>{}}) : null;
const suite = sql ? describe : describe.skip;
const owner = "0x"+"1".repeat(40), stranger = "0x"+"2".repeat(40);
const taskId = "33333333-3333-4333-8333-333333333333", requestId="44444444-4444-4444-8444-444444444444";
const config = {namespace:"agent-market-exploration",chainId:11155111,selectorAddress:"0x"+"3".repeat(40),coordinatorAddress:"0x"+"4".repeat(40)};
const agentId = (i:number)=>`55555555-5555-4555-8555-${String(i).padStart(12,"0")}`;
const vector = "[1,"+Array(383).fill("0").join(",")+"]";
const service=()=>new MatchingService(sql!,config);
const command = {mode:"vrf-exploration",expectedVersion:1};
// Protocol fixture ONLY. It is not a Chainlink proof and is never exposed outside this test DB.
const syntheticEvidence=(b:VrfBinding):OracleSelectionEvidence=>({taskKey:b.taskKey,commitment:b.commitment,requestId:"123",randomWord:"0",
  agentId:b.candidates[0]!.agentId,chainId:b.chainId,selectorAddress:b.selectorAddress,coordinatorAddress:b.coordinatorAddress,
  blockNumber:100,blockHash:"0x"+"b".repeat(64),confirmations:12,selectorCodeHash:"0x"+"c".repeat(64),coordinatorCodeHash:"0x"+"d".repeat(64)});
async function go(event: unknown) {
  const {stdout} = await promisify(execFile)("go",["test","./internal/store","-run","^TestVrfCrossProcess$","-count=1","-v"],{
    cwd:new URL("../../../../services/matcher-go",import.meta.url).pathname,
    env:{...process.env,VRF_TEST_DATABASE_URL:url.toString(),VRF_TEST_EVENT:JSON.stringify(event)},timeout:60000,
  });
  const result=stdout.match(/VRF_RESULT=(\{.*\})/u);
  if(!result) throw new Error(stdout);
  return JSON.parse(result[1]!) as {SelectionStatus:string;Duplicate:boolean;Candidates:unknown[]|null};
}
async function currentInput() { return (await sql!`SELECT input_snapshot FROM agent_market.vrf_selection_intents WHERE task_id=${taskId}`)[0]!.input_snapshot as VrfBindingInput; }
async function fakeCallback() {
  const b=prepareVrfBinding(config,await currentInput());
  return {taskKey:b.taskKey,taskFingerprint:b.taskFingerprint,taskRevision:b.taskRevision,poolRevision:b.poolRevision,poolDigest:b.poolDigest,
    policyVersion:b.policyVersion,commitment:b.commitment,chainId:config.chainId,selectorAddress:config.selectorAddress,
    coordinatorAddress:config.coordinatorAddress,requestId:"123",randomWord:"0",selectedAgentId:b.candidates[0]!.agentId};
}
beforeEach(async()=>{
  if(!sql) return;
  // Only this newly-created dedicated localhost database is touched.
  if ((await sql`SELECT current_database() AS name`)[0]!.name!=="am_vrf_w6_test") throw new Error("UNSAFE_TEST_DATABASE");
  await sql.unsafe("DROP SCHEMA IF EXISTS agent_market CASCADE; DROP TABLE IF EXISTS public.vrf_exploration_bindings CASCADE");
  for(const file of ["0001_agent_market_core.sql","0003_phase2_lifecycle.sql","0005_matcher_profile.sql","0007_agent_matching_score.sql","0012_l2_team_contracts.sql","0024_vrf_matching.sql"])
    await sql.begin(tx=>tx.unsafe(readFileSync(new URL(`../../../../database/migrations/${file}`,import.meta.url),"utf8")
      .replace(/^BEGIN;$/gmu,"").replace(/^COMMIT;$/gmu,"")));
  await sql`INSERT INTO agent_market.tasks(id,publisher_wallet,title,description,requirements,budget_atomic,status,request_id,embedding,category,tags)
    VALUES(${taskId},${owner},'task','task',ARRAY['code'],100,'matching',${requestId},${vector}::vector,'development',ARRAY['typescript'])`;
  for(let i=1;i<=4;i++) await sql`INSERT INTO agent_market.agents(id,owner_wallet,name,description,capabilities,status,available,embedding,categories,tags,model_tag)
    VALUES(${agentId(i)},${i===4?stranger:owner},'agent','agent',ARRAY['code'],'active',true,${vector}::vector,ARRAY['development'],ARRAY['typescript'],${`model-${i}`})`;
  await sql`INSERT INTO agent_market.queen_workflows(task_id,record_version,graph_revision,snapshot,updated_at)
    VALUES(${taskId},1,1,${sql.json({taskId,recordVersion:1,graph:{graphRevision:1},assignments:[],graphConfirmedRevision:null,runId:null})},now())`;
});
afterAll(async()=>{await sql?.end();});
suite("W6 real PostgreSQL + pgvector + Go Process",()=>{
  it("authenticates mode and agent visibility writes; freezes only DB-authorized eligible rows",async()=>{
    await expect(service().configure(stranger,taskId,command)).rejects.toThrow("MATCH_FORBIDDEN");
    await expect(service().configure(owner,taskId,{...command,candidates:[agentId(4)]})).rejects.toThrow("MATCH_INPUT_INVALID");
    await expect(service().setAccess(owner,agentId(4),{access:"public-market",expectedVersion:1})).rejects.toThrow("MATCH_FORBIDDEN");
    await service().setAccess(stranger,agentId(4),{access:"public-market",expectedVersion:1});
    await sql!`UPDATE agent_market.agents SET tags=ARRAY['other'] WHERE id=${agentId(2)}`;
    await sql!`UPDATE agent_market.agents SET available=false WHERE id=${agentId(3)}`;
    const result=await service().configure(owner,taskId,command);
    expect((await currentInput()).pool.candidates.map(c=>c.agentId).sort()).toEqual([agentId(1),agentId(4)]);
    expect(result.fairnessVerified).toBe(false);
    expect((await go(result.event)).SelectionStatus).toBe("oracle_pending");
    expect((await sql!`SELECT count(*)::int AS n FROM agent_market.match_candidates`)[0]!.n).toBe(0);
  },60000);
  it("runs unchanged ranked matching without VRF configuration or oracle availability",async()=>{
    const result=await new MatchingService(sql!,null).configure(owner,taskId,{mode:"ranked",expectedVersion:1});
    const selected=await go(result.event);
    expect(selected.SelectionStatus).toBe("ranked"); expect(selected.Candidates!.length).toBeGreaterThan(0);
  },60000);
  it("serializes duplicate configure and concurrent Go replays without rerank or another pool",async()=>{
    const attempts=await Promise.allSettled([service().configure(owner,taskId,command),service().configure(owner,taskId,command)]);
    expect(attempts.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    const success=attempts.find(x=>x.status==="fulfilled")!;
    if(success.status!=="fulfilled") throw new Error();
    const results=await Promise.all([go(success.value.event),go(success.value.event)]);
    expect(results.every(x=>x.SelectionStatus==="oracle_pending")).toBe(true);
    expect(results.filter(x=>x.Duplicate)).toHaveLength(1);
    expect((await sql!`SELECT count(*)::int AS n FROM public.vrf_exploration_bindings`)[0]!.n).toBe(1);
    const wrongJob=await go({...success.value.event,eventId:randomUUID(),matchJobId:randomUUID()});
    expect(wrongJob.SelectionStatus).toBe("binding_stale");
    await expect(service().configure(owner,taskId,{mode:"ranked",expectedVersion:2})).rejects.toThrow("VRF_REROLL_FORBIDDEN");
    await expect(sql!.begin(async tx=>{await tx`SELECT set_config('agent_market.match_actor',${owner},true)`;await tx`UPDATE agent_market.tasks SET selection_mode='ranked' WHERE id=${taskId}`;})).rejects.toThrow("VRF_REROLL_FORBIDDEN");
  },60000);
  it("qualification writer and freeze use different connections and cannot form a mixed snapshot",async()=>{
    let release!:()=>void; let locked!:()=>void;
    const ready=new Promise<void>(r=>{locked=r}); const unblock=new Promise<void>(r=>{release=r});
    const writer=sql!.begin(async tx=>{
      await tx`UPDATE agent_market.agents SET available=false WHERE id=${agentId(1)}`;
      locked();await unblock;
    });
    await ready;
    const freezing=service().configure(owner,taskId,command);
    try {
      let waiting=false;
      for(let n=0;n<100;n++) {
        const [row]=await sql!`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%vrf_qualification_clock%') AS waiting`;
        if(row!.waiting){waiting=true;break;}
        await new Promise(r=>setTimeout(r,10));
      }
      expect(waiting).toBe(true);
    } finally {release();await writer;}
    await freezing;
    expect((await currentInput()).pool.candidates.map(c=>c.agentId)).not.toContain(agentId(1));
  });
  it("rejects changed qualifications and old task revision without substituting a pool",async()=>{
    const frozen=await service().configure(owner,taskId,command);
    const original=await currentInput();
    await sql!`UPDATE agent_market.agents SET available=false WHERE id=${agentId(1)}`;
    expect((await go(frozen.event)).SelectionStatus).toBe("binding_stale");
    await expect(service().observe(owner,taskId,"123")).rejects.toThrow("VRF_BINDING_STALE");
    await sql!`UPDATE agent_market.tasks SET version=version+1 WHERE id=${taskId}`;
    expect((await go({...frozen.event,eventId:randomUUID()})).SelectionStatus).toBe("binding_stale");
    expect(await currentInput()).toEqual(original);
  },60000);
  it("quarantines callback/replay and denies direct assignment or candidate bypass",async()=>{
    const frozen=await service().configure(owner,taskId,command);
    await service().observe(owner,taskId,"123");
    const callback=await fakeCallback();
    await expect(service().observe(owner,taskId,"123",{...callback,poolDigest:"0x"+"0".repeat(64)})).rejects.toThrow("VRF_CALLBACK_INVALID");
    const view=await service().observe(owner,taskId,"123",callback);
    expect(view).toMatchObject({status:"pending",fairnessVerified:false,selectedAgentId:null});
    await expect(service().observe(owner,taskId,"123",callback)).rejects.toThrow("VRF_REPLAY_FORBIDDEN");
    await expect(sql!`UPDATE agent_market.tasks SET agent_id=${agentId(1)},status='assigned' WHERE id=${taskId}`).rejects.toThrow("VRF_ORACLE_PENDING");
    await expect(sql!`INSERT INTO agent_market.match_candidates(match_job_id,agent_id,request_id,rank,total_score,component_scores,explanation,model_version,exploration)
      VALUES(${frozen.event.matchJobId},${agentId(1)},${requestId},1,1,'{}','{}','fake',true)`).rejects.toThrow("VRF_ORACLE_PENDING");
  });
  it("late callbacks cannot overwrite a confirmed graph or an already completed task",async()=>{
    await service().configure(owner,taskId,command);await service().observe(owner,taskId,"123");
    const callback=await fakeCallback();
    await sql!`UPDATE agent_market.queen_workflows SET snapshot=jsonb_set(snapshot,'{graphConfirmedRevision}','1') WHERE task_id=${taskId}`;
    await expect(service().observe(owner,taskId,"123",callback)).rejects.toThrow("MATCH_TASK_LOCKED");
    await expect(sql!`UPDATE agent_market.queen_workflows SET snapshot=jsonb_set(snapshot,'{assignments}','[["node",{"selectedAgentId":"other"}]]') WHERE task_id=${taskId}`).rejects.toThrow("VRF_ORACLE_PENDING");
    await sql!`UPDATE agent_market.tasks SET status='accepted',version=version+1 WHERE id=${taskId}`;
    await expect(service().observe(owner,taskId,"123",callback)).rejects.toThrow("MATCH_TASK_LOCKED");
    expect((await sql!`SELECT agent_id FROM agent_market.tasks WHERE id=${taskId}`)[0]!.agent_id).toBeNull();
  });
  it("protects the same SQL identity and version semantics against direct mode/pool/request replacement",async()=>{
    await service().configure(owner,taskId,command);
    await expect(sql!`UPDATE agent_market.vrf_selection_intents SET mode='ranked' WHERE task_id=${taskId}`).rejects.toThrow("VRF_REROLL_FORBIDDEN");
    await expect(sql!`DELETE FROM agent_market.vrf_selection_intents WHERE task_id=${taskId}`).rejects.toThrow("VRF_REROLL_FORBIDDEN");
    await expect(sql!`UPDATE public.vrf_exploration_bindings SET value=jsonb_set(value,'{binding,poolRevision}','999'),version=version+1`).rejects.toThrow("VRF_REROLL_FORBIDDEN");
    await expect(sql!`UPDATE agent_market.tasks SET request_id=${randomUUID()} WHERE id=${taskId}`).rejects.toThrow("VRF_REROLL_FORBIDDEN");
    await sql!`UPDATE agent_market.tasks SET tags=ARRAY['changed-without-explicit-version'] WHERE id=${taskId}`;
    expect((await sql!`SELECT version FROM agent_market.tasks WHERE id=${taskId}`)[0]!.version).toBe(3);
    await expect(service().observe(owner,taskId,"123")).rejects.toThrow("VRF_BINDING_STALE");
  });
  it("serializes graph confirmation versus a late callback on separate PG connections",async()=>{
    await service().configure(owner,taskId,command);await service().observe(owner,taskId,"123");
    const data=await fakeCallback();
    let release!:()=>void, locked!:()=>void;
    const ready=new Promise<void>(r=>{locked=r}), unblock=new Promise<void>(r=>{release=r});
    const writer=sql!.begin(async tx=>{
      await tx`UPDATE agent_market.queen_workflows SET snapshot=jsonb_set(snapshot,'{graphConfirmedRevision}','1') WHERE task_id=${taskId}`;
      locked();await unblock;
    });
    await ready;
    const observing=service().observe(owner,taskId,"123",data);
    const outcome=observing.then(()=>"unexpected-success",e=>(e as Error).message);
    try {
      let waiting=false;
      for(let n=0;n<100;n++) {
        const [row]=await sql!`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%advisory_xact_lock%') AS waiting`;
        if(row!.waiting){waiting=true;break;}
        await new Promise(r=>setTimeout(r,10));
      }
      expect(waiting).toBe(true);
    } finally {release();await writer;}
    expect(await outcome).toBe("MATCH_TASK_LOCKED");
    expect((await sql!`SELECT value->>'phase' AS phase FROM public.vrf_exploration_bindings`)[0]!.phase).toBe("awaiting_oracle");
  });
  it("synthetic trusted-reader protocol only: resumes consumed event through actual Go and authorizes only the bound candidate",async()=>{
    const s=new MatchingService(sql!,config,{read:async b=>syntheticEvidence(b)},sql!);
    const frozen=await s.configure(owner,taskId,command);
    expect((await go(frozen.event)).SelectionStatus).toBe("oracle_pending");
    await s.refresh(owner,taskId);
    const [proof]=await sql!`SELECT agent_id FROM agent_market.vrf_verified_selections`;
    const [wakeup]=await sql!`SELECT payload FROM agent_market.outbox_events WHERE id<>${frozen.event.eventId}`;
    expect(proof).toBeDefined();expect(wakeup).toBeDefined();
    const applied=await go(wakeup!.payload);
    expect(applied.SelectionStatus).toBe("verified");
    expect(applied.Candidates).toHaveLength(1);
    const replay=await go(wakeup!.payload);expect(replay.Duplicate).toBe(true);
    expect((await sql!`SELECT count(*)::int AS n FROM agent_market.match_candidates`)[0]!.n).toBe(1);
    const wrong=(await currentInput()).pool.candidates.find(c=>c.agentId!==proof!.agent_id)!.agentId;
    await expect(sql!`UPDATE agent_market.tasks SET agent_id=${wrong},status='assigned' WHERE id=${taskId}`).rejects.toThrow("VRF_ORACLE_PENDING");
    await sql!`UPDATE agent_market.tasks SET agent_id=${proof!.agent_id},status='assigned' WHERE id=${taskId}`;
    await expect(s.status(owner,taskId)).rejects.toThrow("MATCH_TASK_LOCKED");
  },60000);
  it("oracle unavailability remains pending and cannot block explicitly ranked tasks",async()=>{
    let reads=0;
    const s=new MatchingService(sql!,config,{read:async()=>{reads++;throw new Error("offline");}},sql!);
    await s.configure(owner,taskId,command);
    expect(await s.refresh(owner,taskId)).toMatchObject({status:"pending",pendingReason:"oracle-unavailable",fairnessVerified:false,selectedAgentId:null});
    expect(reads).toBe(1);
    expect((await sql!`SELECT count(*)::int AS n FROM agent_market.vrf_verified_selections`)[0]!.n).toBe(0);
  });
  it("rechecks graph locks after an external reader returns; evidence cannot race an accepted graph",async()=>{
    const s=new MatchingService(sql!,config,{read:async b=>{
      await sql!`UPDATE agent_market.queen_workflows SET snapshot=jsonb_set(snapshot,'{graphConfirmedRevision}','1') WHERE task_id=${taskId}`;
      return syntheticEvidence(b);
    }},sql!);
    await s.configure(owner,taskId,command);
    await expect(s.refresh(owner,taskId)).rejects.toThrow("MATCH_TASK_LOCKED");
    expect((await sql!`SELECT count(*)::int AS n FROM agent_market.vrf_verified_selections`)[0]!.n).toBe(0);
  });
  it("reads persisted status without oracle refresh, selection writes, or outbox writes",async()=>{
    let reads=0;
    const s=new MatchingService(sql!,config,{read:async b=>{reads++;return syntheticEvidence(b);}},sql!);
    const frozen=await s.configure(owner,taskId,command);
    expect((await go(frozen.event)).SelectionStatus).toBe("oracle_pending");
    const before=(await sql!`SELECT
      (SELECT count(*)::int FROM agent_market.vrf_verified_selections) AS selections,
      (SELECT count(*)::int FROM agent_market.outbox_events) AS outbox,
      (SELECT value FROM public.vrf_exploration_bindings LIMIT 1) AS binding`)[0]!;

    expect(await s.status(owner,taskId)).toMatchObject({status:"pending",fairnessVerified:false,selectedAgentId:null});

    const after=(await sql!`SELECT
      (SELECT count(*)::int FROM agent_market.vrf_verified_selections) AS selections,
      (SELECT count(*)::int FROM agent_market.outbox_events) AS outbox,
      (SELECT value FROM public.vrf_exploration_bindings LIMIT 1) AS binding`)[0]!;
    expect(reads).toBe(0);
    expect(after).toEqual(before);
  },60000);
  it("grants only the dedicated chain reader recorder execution and denies direct table writes",async()=>{
    await service().configure(owner,taskId,command);
    await service().observe(owner,taskId,"123");
    const binding=prepareVrfBinding(config,await currentInput());
    const evidence=syntheticEvidence(binding);
    const suffix=randomUUID().replaceAll("-","").slice(0,12);
    const readerRole=`am_vrf_reader_${suffix}`, appRole=`am_vrf_app_${suffix}`;
    const readerPassword=randomUUID(), appPassword=randomUUID();
    const readerUrl=new URL(url), appUrl=new URL(url);
    readerUrl.username=readerRole;readerUrl.password=readerPassword;
    appUrl.username=appRole;appUrl.password=appPassword;
    let reader:ReturnType<typeof postgres>|undefined, app:ReturnType<typeof postgres>|undefined;
    try {
      await sql!.unsafe(`CREATE ROLE "${readerRole}" LOGIN NOINHERIT PASSWORD '${readerPassword}'`);
      await sql!.unsafe(`CREATE ROLE "${appRole}" LOGIN NOINHERIT PASSWORD '${appPassword}'`);
      await sql!.unsafe(`GRANT CONNECT ON DATABASE am_vrf_w6_test TO "${appRole}"`);
      await sql!.unsafe(`GRANT USAGE ON SCHEMA agent_market TO "${appRole}"`);
      const grants=readFileSync(new URL("../../../../database/vrf-chain-reader-grants.sql",import.meta.url),"utf8")
        .split("\n").filter(line=>!line.trimStart().startsWith("\\")).join("\n")
        .replaceAll(":'vrf_chain_reader_role'",`'${readerRole}'`)
        .replaceAll(":'app_runtime_role'",`'${appRole}'`);
      await sql!.unsafe(grants);
      reader=postgres(readerUrl.toString(),{max:1,prepare:false,onnotice:()=>{}});
      app=postgres(appUrl.toString(),{max:1,prepare:false,onnotice:()=>{}});
      const params=[taskId,binding.taskKey,evidence.agentId,
        `${binding.chainId}:${binding.selectorAddress}:${evidence.requestId}`,evidence];
      await expect(reader.unsafe(`INSERT INTO agent_market.vrf_verified_selections(task_id,binding_key,agent_id,request_key,evidence)
        VALUES($1,$2,$3,$4,$5::jsonb)`,params as never[])).rejects.toMatchObject({code:"42501"});
      await expect(app.unsafe("SELECT agent_market.vrf_record_verified_selection($1,$2,$3,$4,$5::jsonb)",params as never[]))
        .rejects.toMatchObject({code:"42501"});
      await reader.unsafe("SELECT agent_market.vrf_record_verified_selection($1,$2,$3,$4,$5::jsonb)",params as never[]);
      expect((await sql!`SELECT count(*)::int AS n FROM agent_market.vrf_verified_selections`)[0]!.n).toBe(1);
    } finally {
      await reader?.end();await app?.end();
      await sql!.unsafe(`DROP OWNED BY "${readerRole}"; DROP OWNED BY "${appRole}"; DROP ROLE IF EXISTS "${readerRole}"; DROP ROLE IF EXISTS "${appRole}"`);
    }
  });
});
