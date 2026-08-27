SET search_path TO agent_market, public;

ALTER TABLE chain_transactions
  DROP CONSTRAINT IF EXISTS chain_transactions_method_check;

ALTER TABLE chain_transactions
  ADD CONSTRAINT chain_transactions_method_check CHECK (method IN (
    'faucet','approve','createTask','createWorkflowTask','assignAgent','acceptTask',
    'submitWork','acceptWork','timeoutTask','openDispute','castVote',
    'resolveWorkflowTask','stake','unstake','claimYield'
  ));
