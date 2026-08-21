import { getAddress, id } from "ethers";
import { v5 as uuidv5 } from "uuid";

import type { TransactionMethod } from "./intents";
import { normalizeResourceId, type ChainResourceRecord } from "./resources";

export interface ContractAllowlist {
  token: string;
  escrow: string;
  committee: string;
  vault: string;
}

export interface ChainResourceBinding {
  taskId: string;
  requestRef: string;
}

export function deriveChainResource(resourceId: string): ChainResourceBinding {
  const normalized = normalizeResourceId(resourceId);
  return {
    taskId: id(`agent-market:task:${normalized}`).toLowerCase(),
    requestRef: id(`agent-market:request:${normalized}`).toLowerCase(),
  };
}

export function deriveIntentRequestId(actorWallet: string, resourceId: string, method: TransactionMethod): string {
  return uuidv5(
    `agent-market:intent:${getAddress(actorWallet)}:${normalizeResourceId(resourceId)}:${method}`,
    uuidv5.URL,
  );
}

export function normalizeContractAllowlist(input: ContractAllowlist): ContractAllowlist {
  return {
    token: getAddress(input.token).toLowerCase(),
    escrow: getAddress(input.escrow).toLowerCase(),
    committee: getAddress(input.committee).toLowerCase(),
    vault: getAddress(input.vault).toLowerCase(),
  };
}

export function contractForMethod(method: TransactionMethod, contracts: ContractAllowlist): string {
  if (method === "faucet" || method === "approve") return contracts.token;
  if (method === "castVote") return contracts.committee;
  if (method === "stake" || method === "unstake" || method === "claimYield") return contracts.vault;
  return contracts.escrow;
}

export function bindMethodArguments(
  method: TransactionMethod,
  args: Record<string, unknown>,
  resource: ChainResourceBinding,
  contracts: ContractAllowlist,
  record?: ChainResourceRecord,
): Record<string, unknown> {
  const bound = { ...args };
  if (["createTask", "assignAgent", "acceptTask", "submitWork", "acceptWork", "timeoutTask", "openDispute", "castVote"].includes(method)) {
    bound.taskId = resource.taskId;
  }
  if (method === "createTask") {
    if (record === undefined) throw new Error("CHAIN_RESOURCE_EXPECTATION_MISSING");
    bound.budgetAtomic = record.budgetAtomic;
  }
  if (method === "assignAgent") {
    if (record?.agentWallet === null || record?.agentWallet === undefined) {
      throw new Error("CHAIN_RESOURCE_AGENT_MISSING");
    }
    bound.agent = record.agentWallet;
  }
  if (method === "approve") {
    const spender = typeof bound.spender === "string" ? getAddress(bound.spender).toLowerCase() : "";
    if (spender !== contracts.escrow && spender !== contracts.vault) throw new Error("CHAIN_SPENDER_FORBIDDEN");
    bound.spender = spender;
  }
  return bound;
}
