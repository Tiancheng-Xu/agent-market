BEGIN;
-- Legacy payloads and confirmations are retained unchanged, never asset-backfilled.
ALTER TABLE agent_market.risk_quote_confirmations ADD COLUMN quote_hash text
  CHECK (quote_hash IS NULL OR quote_hash ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE agent_market.risk_quotes ADD CONSTRAINT risk_quote_asset_version CHECK (COALESCE((
  (COALESCE(quote_payload->>'schemaVersion','1') = '1' AND NOT quote_payload ? 'assetId')
  OR (quote_payload->>'schemaVersion' = '2' AND jsonb_typeof(quote_payload->'assetId') = 'string'
    AND quote_payload->>'assetId' ~ '^eip155:[1-9][0-9]{0,15}/erc20:0x[0-9a-f]{40}$'
    AND quote_payload->>'assetId' !~ '0x0{40}$')
), false));
CREATE FUNCTION agent_market.guard_risk_asset_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q agent_market.risk_quotes;
BEGIN
  SELECT * INTO q FROM agent_market.risk_quotes WHERE id=NEW.quote_id FOR SHARE;
  IF q.id IS NULL OR q.quote_payload->>'schemaVersion' IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'RISK_QUOTE_REQUOTE_REQUIRED';
  END IF;
  IF q.status <> 'active' THEN RAISE EXCEPTION 'RISK_QUOTE_SUPERSEDED'; END IF;
  IF NEW.quote_hash IS DISTINCT FROM q.basis_fingerprint OR NEW.task_fingerprint IS DISTINCT FROM q.task_fingerprint THEN
    RAISE EXCEPTION 'RISK_QUOTE_HASH_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER risk_asset_confirmation BEFORE INSERT OR UPDATE ON agent_market.risk_quote_confirmations
FOR EACH ROW EXECUTE FUNCTION agent_market.guard_risk_asset_confirmation();
COMMIT;
