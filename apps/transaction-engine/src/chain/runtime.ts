import type { ChainReader } from "./reconcile";
import { BlockscoutMcpChainReader, JsonRpcChainReader, JsonRpcVaultPositionReader, type VaultPositionReader } from "./readers";
import { normalizeContractAllowlist, type ContractAllowlist } from "./policy";
import { PostgresTransactionStore, type TransactionStore } from "./transaction-store";
import { PostgresChainResourceRepository, type ChainResourceRepository } from "./resources";

export interface TransactionRuntime {
  store: TransactionStore;
  resources: ChainResourceRepository;
  rpc: ChainReader;
  blockscout: ChainReader;
  contracts: ContractAllowlist;
  vaultReadback?: VaultPositionReader;
}

let testRuntime: TransactionRuntime | undefined;
let productionRuntime: TransactionRuntime | undefined;

export function setTransactionRuntimeForTests(runtime: TransactionRuntime | undefined): void {
  testRuntime = runtime;
}

export function getTransactionRuntime(): TransactionRuntime {
  if (testRuntime) return testRuntime;
  if (productionRuntime) return productionRuntime;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const rpcUrl = process.env.SEPOLIA_RPC_URL?.trim();
  const token = process.env.AGENT_MARKET_YD_TOKEN_ADDRESS?.trim();
  const escrow = process.env.AGENT_MARKET_ESCROW_ADDRESS?.trim();
  const committee = process.env.AGENT_MARKET_COMMITTEE_ADDRESS?.trim();
  const vault = process.env.AGENT_MARKET_VAULT_ADDRESS?.trim();
  const workflowEscrow = process.env.AGENT_MARKET_WORKFLOW_ESCROW_ADDRESS?.trim();
  const platformArbiter = process.env.AGENT_MARKET_PLATFORM_ARBITER_WALLET?.trim();
  const committeeMembers = (process.env.AGENT_MARKET_COMMITTEE_MEMBER_WALLETS ?? "")
    .split(",").map((wallet) => wallet.trim()).filter((wallet) => wallet.length > 0);
  if (!databaseUrl || !rpcUrl || !/^https:\/\//u.test(rpcUrl) || !token || !escrow || !committee || !vault) {
    throw new Error("CHAIN_RUNTIME_NOT_CONFIGURED");
  }
  productionRuntime = {
    store: PostgresTransactionStore.connect(databaseUrl),
    resources: PostgresChainResourceRepository.connect(databaseUrl, committeeMembers, platformArbiter),
    rpc: new JsonRpcChainReader(rpcUrl),
    blockscout: new BlockscoutMcpChainReader(),
    vaultReadback: new JsonRpcVaultPositionReader(rpcUrl, vault),
    contracts: normalizeContractAllowlist({ token, escrow, committee, vault, ...(workflowEscrow ? { workflowEscrow } : {}) }),
  };
  return productionRuntime;
}
