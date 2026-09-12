BEGIN;
ALTER TABLE agent_market.tasks ADD COLUMN selection_mode text NOT NULL DEFAULT 'ranked'
  CHECK (selection_mode IN ('ranked','vrf-exploration'));
ALTER TABLE agent_market.agents ADD COLUMN selection_access text NOT NULL DEFAULT 'owner-only'
  CHECK (selection_access IN ('owner-only','public-market'));
CREATE TABLE agent_market.vrf_qualification_clock (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision bigint NOT NULL);
INSERT INTO agent_market.vrf_qualification_clock VALUES(true,1);
CREATE TABLE IF NOT EXISTS public.vrf_exploration_bindings (
  task_key text PRIMARY KEY, version integer NOT NULL CHECK(version>0), value jsonb NOT NULL, request_key text UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS vrf_binding_task_identity ON public.vrf_exploration_bindings
  ((value #>> '{binding,namespace}'),(value #>> '{binding,taskId}'));
CREATE TABLE agent_market.vrf_selection_intents (
  task_id uuid PRIMARY KEY REFERENCES agent_market.tasks(id),
  mode text NOT NULL CHECK(mode IN ('ranked','vrf-exploration')),
  task_version integer NOT NULL, request_id uuid NOT NULL,
  match_job_id uuid NOT NULL UNIQUE, event_id uuid NOT NULL,
  model_version text NOT NULL, qualification_revision bigint NOT NULL,
  workflow_stamp jsonb NOT NULL, input_snapshot jsonb NOT NULL,
  binding_key text UNIQUE REFERENCES public.vrf_exploration_bindings(task_key),
  configured_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode='vrf-exploration')=(binding_key IS NOT NULL))
);
CREATE TABLE agent_market.vrf_verified_selections (
  task_id uuid PRIMARY KEY REFERENCES agent_market.vrf_selection_intents(task_id),
  binding_key text NOT NULL UNIQUE REFERENCES public.vrf_exploration_bindings(task_key),
  agent_id uuid NOT NULL REFERENCES agent_market.agents(id),
  request_key text NOT NULL UNIQUE,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  verified_at timestamptz NOT NULL DEFAULT now()
);

-- The clock's write lock is acquired BEFORE any qualification statement changes rows.
-- Readers hold FOR SHARE until their snapshot/binding transaction commits, preventing phantoms.
CREATE FUNCTION agent_market.vrf_qualification_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE agent_market.vrf_qualification_clock SET revision=revision+1 WHERE singleton; RETURN NULL; END $$;
CREATE TRIGGER vrf_agents_qualification BEFORE INSERT OR UPDATE OR DELETE ON agent_market.agents
  FOR EACH STATEMENT EXECUTE FUNCTION agent_market.vrf_qualification_changed();
CREATE TRIGGER vrf_scores_qualification BEFORE INSERT OR UPDATE OR DELETE ON agent_market.agent_score_events
  FOR EACH STATEMENT EXECUTE FUNCTION agent_market.vrf_qualification_changed();

CREATE FUNCTION agent_market.vrf_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.selection_mode='vrf-exploration' AND
    (NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.publisher_wallet IS DISTINCT FROM OLD.publisher_wallet)
    THEN RAISE EXCEPTION 'VRF_REROLL_FORBIDDEN'; END IF;
  IF NEW.selection_mode IS DISTINCT FROM OLD.selection_mode THEN
    IF lower(COALESCE(current_setting('agent_market.match_actor',true),'')) <> lower(OLD.publisher_wallet)
      THEN RAISE EXCEPTION 'MATCH_FORBIDDEN'; END IF;
    IF EXISTS(SELECT 1 FROM agent_market.vrf_selection_intents WHERE task_id=OLD.id)
      OR OLD.agent_id IS NOT NULL OR OLD.status <> 'matching'
      OR EXISTS(SELECT 1 FROM agent_market.match_candidates WHERE request_id=OLD.request_id)
      OR EXISTS(SELECT 1 FROM agent_market.consumed_events WHERE request_id=OLD.request_id AND consumer='matcher-go')
      THEN RAISE EXCEPTION 'VRF_REROLL_FORBIDDEN'; END IF;
  END IF;
  IF OLD.selection_mode='vrf-exploration' AND NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
    IF NOT agent_market.vrf_assignment_allowed(OLD.id,NEW.agent_id) THEN RAISE EXCEPTION 'VRF_ORACLE_PENDING'; END IF;
  END IF;
  IF ROW(NEW.requirements,NEW.tags,NEW.category,NEW.budget_atomic,NEW.embedding,NEW.status,NEW.agent_id)
    IS DISTINCT FROM ROW(OLD.requirements,OLD.tags,OLD.category,OLD.budget_atomic,OLD.embedding,OLD.status,OLD.agent_id)
    THEN NEW.version := GREATEST(NEW.version,OLD.version+1); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vrf_task_write_guard BEFORE UPDATE ON agent_market.tasks FOR EACH ROW EXECUTE FUNCTION agent_market.vrf_task_guard();
CREATE FUNCTION agent_market.vrf_access_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.selection_access IS DISTINCT FROM OLD.selection_access AND
    lower(COALESCE(current_setting('agent_market.match_actor',true),'')) <> lower(OLD.owner_wallet)
    THEN RAISE EXCEPTION 'MATCH_FORBIDDEN'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vrf_access_write_guard BEFORE UPDATE ON agent_market.agents FOR EACH ROW EXECUTE FUNCTION agent_market.vrf_access_guard();

CREATE FUNCTION agent_market.vrf_workflow_stamp(target uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE relation regclass; result jsonb;
BEGIN
  relation := COALESCE(to_regclass('queen_runtime_public.queen_workflows'),to_regclass('agent_market.queen_workflows'));
  IF relation IS NULL OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation AND tgname='vrf_workflow_write_guard' AND tgenabled<>'D')
    THEN RAISE EXCEPTION 'VRF_WORKFLOW_GUARD_UNAVAILABLE'; END IF;
  EXECUTE format('SELECT jsonb_build_object(''recordVersion'',record_version,''graphRevision'',graph_revision,''snapshot'',snapshot) FROM %s WHERE task_id=$1 FOR UPDATE',relation)
    INTO result USING target;
  RETURN COALESCE(result,'{}'::jsonb);
END $$;
CREATE FUNCTION agent_market.vrf_workflow_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.task_id::text,240024));
  IF EXISTS(SELECT 1 FROM agent_market.vrf_selection_intents WHERE task_id=NEW.task_id AND mode='vrf-exploration') THEN
    IF TG_OP='INSERT' THEN RAISE EXCEPTION 'VRF_ORACLE_PENDING'; END IF;
    IF NEW.snapshot->'assignments' IS DISTINCT FROM OLD.snapshot->'assignments'
      OR NEW.snapshot->'graph' IS DISTINCT FROM OLD.snapshot->'graph'
      THEN RAISE EXCEPTION 'VRF_ORACLE_PENDING'; END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE relation regclass; BEGIN
  FOREACH relation IN ARRAY ARRAY[to_regclass('queen_runtime_public.queen_workflows'),to_regclass('agent_market.queen_workflows')] LOOP
    IF relation IS NOT NULL THEN
      EXECUTE format('CREATE TRIGGER vrf_workflow_write_guard BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION agent_market.vrf_workflow_guard()',relation);
    END IF;
  END LOOP;
END $$;

-- Called by the actual Go Process before ordinary ranking. Any lookup/error fails closed.
CREATE FUNCTION agent_market.vrf_match_gate(target uuid, req uuid, job uuid, model text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE t agent_market.tasks; i agent_market.vrf_selection_intents; stamp jsonb; q bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(target::text,240024));
  SELECT * INTO t FROM agent_market.tasks WHERE id=target FOR UPDATE;
  IF NOT FOUND OR t.request_id<>req OR t.status<>'matching' OR t.agent_id IS NOT NULL THEN
    RAISE EXCEPTION 'MATCH_TASK_LOCKED'; END IF;
  SELECT * INTO i FROM agent_market.vrf_selection_intents WHERE task_id=target;
  IF t.selection_mode='ranked' THEN
    IF FOUND AND i.mode<>'ranked' THEN RAISE EXCEPTION 'VRF_REROLL_FORBIDDEN'; END IF;
    RETURN 'ranked';
  END IF;
  IF i.task_id IS NULL OR i.mode<>'vrf-exploration' OR i.binding_key IS NULL THEN
    RAISE EXCEPTION 'VRF_BINDING_MISSING'; END IF;
  stamp := agent_market.vrf_workflow_stamp(target);
  SELECT revision INTO q FROM agent_market.vrf_qualification_clock WHERE singleton FOR SHARE;
  IF t.version<>i.task_version OR q<>i.qualification_revision OR stamp<>i.workflow_stamp
    OR i.request_id<>req OR i.match_job_id<>job OR i.model_version<>model THEN RETURN 'binding_stale'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.vrf_exploration_bindings WHERE task_key=i.binding_key
    AND value #>> '{binding,taskId}'=target::text
    AND (value #>> '{binding,taskRevision}')::integer=t.version) THEN RAISE EXCEPTION 'VRF_BINDING_MISSING'; END IF;
  IF EXISTS(SELECT 1 FROM agent_market.vrf_verified_selections WHERE task_id=target AND binding_key=i.binding_key) THEN
    RETURN 'verified:'||(SELECT agent_id::text FROM agent_market.vrf_verified_selections WHERE task_id=target);
  END IF;
  RETURN 'oracle_pending';
END $$;
CREATE FUNCTION agent_market.vrf_assignment_allowed(target uuid,agent uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE i agent_market.vrf_selection_intents;
BEGIN
  SELECT * INTO i FROM agent_market.vrf_selection_intents WHERE task_id=target;
  IF NOT FOUND OR agent IS NULL THEN RETURN false; END IF;
  RETURN agent_market.vrf_match_gate(target,i.request_id,i.match_job_id,i.model_version)='verified:'||agent::text;
END $$;
CREATE FUNCTION agent_market.vrf_candidate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode text; target uuid;
BEGIN
  SELECT t.selection_mode,t.id INTO mode,target FROM agent_market.tasks t
    LEFT JOIN agent_market.vrf_selection_intents i ON i.task_id=t.id
    WHERE t.request_id=NEW.request_id OR i.match_job_id=NEW.match_job_id
    ORDER BY (t.selection_mode='vrf-exploration') DESC LIMIT 1 FOR UPDATE OF t;
  IF mode='vrf-exploration' AND NOT agent_market.vrf_assignment_allowed(target,NEW.agent_id) THEN RAISE EXCEPTION 'VRF_ORACLE_PENDING'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vrf_candidate_write_guard BEFORE INSERT OR UPDATE ON agent_market.match_candidates
  FOR EACH ROW EXECUTE FUNCTION agent_market.vrf_candidate_guard();

CREATE FUNCTION agent_market.vrf_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'VRF_REROLL_FORBIDDEN'; END $$;
CREATE TRIGGER vrf_intent_no_replacement BEFORE UPDATE OR DELETE ON agent_market.vrf_selection_intents
  FOR EACH ROW EXECUTE FUNCTION agent_market.vrf_intent_immutable();
CREATE TRIGGER vrf_verified_no_replacement BEFORE UPDATE OR DELETE ON agent_market.vrf_verified_selections
  FOR EACH ROW EXECUTE FUNCTION agent_market.vrf_intent_immutable();
CREATE FUNCTION agent_market.vrf_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'VRF_REROLL_FORBIDDEN'; END IF;
  IF NEW.task_key<>OLD.task_key OR NEW.value->'binding' IS DISTINCT FROM OLD.value->'binding'
    OR NEW.version<>OLD.version+1 OR (OLD.request_key IS NOT NULL AND NEW.request_key IS DISTINCT FROM OLD.request_key)
    THEN RAISE EXCEPTION 'VRF_REROLL_FORBIDDEN'; END IF;
  IF NOT ((OLD.value->>'phase'='awaiting_request' AND NEW.value->>'phase'='awaiting_oracle')
    OR (OLD.value->>'phase'='awaiting_oracle' AND NEW.value->>'phase'='callback_bound'))
    THEN RAISE EXCEPTION 'VRF_REPLAY_FORBIDDEN'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vrf_binding_no_replacement BEFORE UPDATE OR DELETE ON public.vrf_exploration_bindings
  FOR EACH ROW EXECUTE FUNCTION agent_market.vrf_binding_immutable();
CREATE FUNCTION agent_market.vrf_record_verified_selection(
  target uuid, binding text, selected_agent uuid, request_identity text, proof jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, agent_market, public AS $$
DECLARE i agent_market.vrf_selection_intents; b jsonb; candidate jsonb; total numeric:=0; ticket numeric; winner text; wakeup_id uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO i FROM agent_market.vrf_selection_intents WHERE task_id=target;
  IF NOT FOUND OR i.binding_key<>binding OR agent_market.vrf_match_gate(i.task_id,i.request_id,i.match_job_id,i.model_version)<>'oracle_pending'
    THEN RAISE EXCEPTION 'VRF_BINDING_STALE'; END IF;
  SELECT value INTO b FROM public.vrf_exploration_bindings WHERE task_key=binding;
  IF proof->>'commitment' IS DISTINCT FROM b #>> '{binding,commitment}'
    OR proof->>'taskKey' IS DISTINCT FROM binding
    OR proof->>'requestId' IS DISTINCT FROM b->>'requestId'
    OR proof->>'selectorAddress' IS DISTINCT FROM b #>> '{binding,selectorAddress}'
    OR proof->>'coordinatorAddress' IS DISTINCT FROM b #>> '{binding,coordinatorAddress}'
    OR proof->>'chainId' IS DISTINCT FROM b #>> '{binding,chainId}'
    OR request_identity IS DISTINCT FROM (b #>> '{binding,chainId}')||':'||(b #>> '{binding,selectorAddress}')||':'||(b->>'requestId')
    OR COALESCE((proof->>'confirmations')::integer,0)<3
    OR COALESCE((proof->>'blockNumber')::bigint,-1)<0
    OR COALESCE(proof->>'blockHash','') !~ '^0x[0-9a-fA-F]{64}$'
    OR COALESCE(proof->>'selectorCodeHash','') !~ '^0x[0-9a-fA-F]{64}$'
    OR COALESCE(proof->>'coordinatorCodeHash','') !~ '^0x[0-9a-fA-F]{64}$'
    OR COALESCE(proof->>'randomWord','') !~ '^(0|[1-9][0-9]{0,77})$'
    THEN RAISE EXCEPTION 'VRF_EVIDENCE_INVALID'; END IF;
  ticket:=(proof->>'randomWord')::numeric;
  IF ticket>=power(2::numeric,256) THEN RAISE EXCEPTION 'VRF_EVIDENCE_INVALID'; END IF;
  FOR candidate IN SELECT value FROM jsonb_array_elements(b #> '{binding,candidates}') LOOP total:=total+(candidate->>'weight')::numeric; END LOOP;
  ticket:=mod(ticket,total);
  FOR candidate IN SELECT value FROM jsonb_array_elements(b #> '{binding,candidates}') LOOP
    IF ticket<(candidate->>'weight')::numeric THEN winner:=candidate->>'agentId'; EXIT; END IF;
    ticket:=ticket-(candidate->>'weight')::numeric;
  END LOOP;
  IF winner IS DISTINCT FROM selected_agent::text OR winner IS DISTINCT FROM proof->>'agentId'
    THEN RAISE EXCEPTION 'VRF_EVIDENCE_INVALID'; END IF;
  INSERT INTO agent_market.vrf_verified_selections(task_id,binding_key,agent_id,request_key,evidence)
    VALUES(target,binding,selected_agent,request_identity,proof);
  INSERT INTO agent_market.outbox_events(id,aggregate_type,aggregate_id,event_type,request_id,topic,payload)
    VALUES(wakeup_id,'task',target,'match.requested.v1',wakeup_id,'match.requested.v1',
      i.input_snapshot->'match'||jsonb_build_object('eventId',wakeup_id,'type','match.requested.v1','occurredAt',clock_timestamp()));
  RETURN wakeup_id;
END $$;
REVOKE INSERT ON agent_market.vrf_verified_selections FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_market.vrf_record_verified_selection(uuid,text,uuid,text,jsonb) FROM PUBLIC;
COMMIT;
