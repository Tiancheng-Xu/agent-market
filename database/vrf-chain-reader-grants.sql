\set ON_ERROR_STOP on

\if :{?vrf_chain_reader_role}
\else
  \echo 'missing required psql variable: vrf_chain_reader_role'
  \quit
\endif

\if :{?app_runtime_role}
\else
  \echo 'missing required psql variable: app_runtime_role'
  \quit
\endif

-- DBA-only deployment step. Roles and credentials must be provisioned separately.
-- The reader must be a dedicated NOINHERIT role with no role memberships.
SELECT set_config('agent_market.vrf_chain_reader_grant_role', :'vrf_chain_reader_role', false);
SELECT set_config('agent_market.app_runtime_grant_role', :'app_runtime_role', false);

DO $grant$
DECLARE
  reader_role text := current_setting('agent_market.vrf_chain_reader_grant_role');
  app_role text := current_setting('agent_market.app_runtime_grant_role');
  reader pg_roles%ROWTYPE;
  recorder regprocedure := 'agent_market.vrf_record_verified_selection(uuid,text,uuid,text,jsonb)'::regprocedure;
BEGIN
  SELECT * INTO reader FROM pg_roles WHERE rolname = reader_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VRF_CHAIN_READER_ROLE_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE EXCEPTION 'APP_RUNTIME_ROLE_MISSING';
  END IF;
  IF reader_role = app_role THEN
    RAISE EXCEPTION 'VRF_CHAIN_READER_ROLE_REUSED';
  END IF;
  IF reader.rolinherit OR reader.rolsuper OR reader.rolcreaterole OR reader.rolcreatedb
    OR reader.rolreplication OR reader.rolbypassrls
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = reader.oid) THEN
    RAISE EXCEPTION 'VRF_CHAIN_READER_ROLE_NOT_DEDICATED';
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), reader_role);
  EXECUTE format('GRANT USAGE ON SCHEMA agent_market TO %I', reader_role);
  EXECUTE format('REVOKE CREATE ON SCHEMA agent_market FROM %I', reader_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA agent_market FROM %I', reader_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA agent_market FROM %I', reader_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA agent_market FROM %I', reader_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.vrf_exploration_bindings FROM %I', reader_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', recorder, reader_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', recorder, app_role);

  IF has_table_privilege(reader_role, 'agent_market.vrf_verified_selections', 'INSERT') THEN
    RAISE EXCEPTION 'VRF_CHAIN_READER_TABLE_WRITE_STILL_AUTHORIZED';
  END IF;
  IF NOT has_function_privilege(reader_role, recorder, 'EXECUTE') THEN
    RAISE EXCEPTION 'VRF_CHAIN_READER_FUNCTION_NOT_AUTHORIZED';
  END IF;
  IF has_function_privilege(app_role, recorder, 'EXECUTE') THEN
    RAISE EXCEPTION 'APP_RUNTIME_FUNCTION_STILL_AUTHORIZED';
  END IF;
END
$grant$;

RESET agent_market.vrf_chain_reader_grant_role;
RESET agent_market.app_runtime_grant_role;
