import { getAddress, HDNodeWallet, isAddress, isHexString, Mnemonic } from "ethers";

import type { DeploymentManifestV1 } from "./deployment-manifest";
import { SEPOLIA_CHAIN_ID } from "./deployment-manifest";

export const ROLE_INDEXES = {
  deployer: 0,
  committee: [1, 2, 3, 4, 5],
  publisher: 6,
  agent: 7,
  treasury: 8,
} as const;

export interface RoleAddresses {
  deployer: string;
  committee: string[];
  publisher: string;
  agent: string;
  treasury: string;
}

export interface TransactionEvidence {
  action: string;
  transactionHash: string;
  blockNumber: number;
  status: 1;
}

export interface ScenarioEvidence {
  taskId: string;
  requestRef: string;
  finalState: "SETTLED" | "REFUNDED";
  agentWins: boolean;
  budgetAtomic: string;
  bondPaidToPlatformAtomic: string;
  yieldPaidAtomic: string;
  transactions: TransactionEvidence[];
}

export interface SepoliaClosureEvidenceInput {
  capturedAt: string;
  deployment: DeploymentManifestV1;
  roles: RoleAddresses;
  normalSettlement: ScenarioEvidence;
  disputeSettlement: ScenarioEvidence;
  staking: {
    principalAtomic: string;
    finalPrincipalAtomic: string;
    transactions: TransactionEvidence[];
  };
  rpcReadback: {
    checkedTransactions: number;
    allReceiptsSuccessful: boolean;
  };
}

export interface SepoliaClosureEvidence extends SepoliaClosureEvidenceInput {
  schemaVersion: 1;
  project: "agent-market";
  network: "sepolia";
  chainId: typeof SEPOLIA_CHAIN_ID;
  status: "rpc-verified-blockscout-pending";
}

function deriveAddress(mnemonic: Mnemonic, index: number): string {
  return HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`).address;
}

export function deriveRoleAddresses(phrase: string): RoleAddresses {
  const mnemonic = Mnemonic.fromPhrase(phrase.trim());
  const committee = ROLE_INDEXES.committee.map((index) => deriveAddress(mnemonic, index));
  const roles = {
    deployer: deriveAddress(mnemonic, ROLE_INDEXES.deployer),
    committee,
    publisher: deriveAddress(mnemonic, ROLE_INDEXES.publisher),
    agent: deriveAddress(mnemonic, ROLE_INDEXES.agent),
    treasury: deriveAddress(mnemonic, ROLE_INDEXES.treasury),
  };
  const addresses = [roles.deployer, ...committee, roles.publisher, roles.agent, roles.treasury];
  if (addresses.some((address) => !isAddress(address)) || new Set(addresses.map(getAddress)).size !== addresses.length) {
    throw new Error("SEPOLIA_ROLE_ADDRESSES_INVALID");
  }
  return roles;
}

function validateTransaction(transaction: TransactionEvidence): void {
  if (!transaction.action || !isHexString(transaction.transactionHash, 32)
    || !Number.isSafeInteger(transaction.blockNumber) || transaction.blockNumber <= 0
    || transaction.status !== 1) {
    throw new Error("SEPOLIA_TRANSACTION_EVIDENCE_INVALID");
  }
}

function validateScenario(scenario: ScenarioEvidence): void {
  if (!isHexString(scenario.taskId, 32) || !isHexString(scenario.requestRef, 32)
    || !/^(?:0|[1-9]\d*)$/u.test(scenario.budgetAtomic)
    || !/^(?:0|[1-9]\d*)$/u.test(scenario.bondPaidToPlatformAtomic)
    || !/^(?:0|[1-9]\d*)$/u.test(scenario.yieldPaidAtomic)
    || scenario.transactions.length === 0) {
    throw new Error("SEPOLIA_SCENARIO_EVIDENCE_INVALID");
  }
  scenario.transactions.forEach(validateTransaction);
}

export function createSepoliaClosureEvidence(
  input: SepoliaClosureEvidenceInput,
  forbiddenValues: readonly string[] = [],
): SepoliaClosureEvidence {
  if (input.deployment.chainId !== SEPOLIA_CHAIN_ID
    || Number.isNaN(Date.parse(input.capturedAt))
    || !input.rpcReadback.allReceiptsSuccessful
    || input.rpcReadback.checkedTransactions <= 0) {
    throw new Error("SEPOLIA_CLOSURE_EVIDENCE_INVALID");
  }
  validateScenario(input.normalSettlement);
  validateScenario(input.disputeSettlement);
  input.staking.transactions.forEach(validateTransaction);
  const evidence: SepoliaClosureEvidence = {
    schemaVersion: 1,
    project: "agent-market",
    network: "sepolia",
    chainId: SEPOLIA_CHAIN_ID,
    status: "rpc-verified-blockscout-pending",
    ...input,
  };
  const serialized = JSON.stringify(evidence);
  for (const value of forbiddenValues.map((item) => item.trim()).filter((item) => item.length >= 4)) {
    if (serialized.includes(value)) throw new Error("SEPOLIA_CLOSURE_EVIDENCE_CONTAINS_SECRET");
  }
  return evidence;
}
