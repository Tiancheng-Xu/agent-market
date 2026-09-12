import { getAddress, id } from "ethers";
import { v5 as uuidv5 } from "uuid";

import type { TransactionMethod } from "./intents";
import { normalizeResourceId, type ChainResourceRecord } from "./resources";

export interface ContractAllowlist {
  token: string;
  escrow: string;
  committee: string;
  vault: string;
  workflowEscrow?: string;
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

export function deriveIntentRequestId(actorWallet: string, resourceId: string, method: TransactionMethod, binding = ""): string {
  return uuidv5(
    `agent-market:intent:${getAddress(actorWallet)}:${normalizeResourceId(resourceId)}:${method}:${binding}`,
    uuidv5.URL,
  );
}

export function deriveAccountResourceId(walletAddress: string): string {
  return uuidv5(`agent-market:chain-account:${getAddress(walletAddress)}`, uuidv5.URL);
}

export function normalizeContractAllowlist(input: ContractAllowlist): ContractAllowlist {
  return {
    token: getAddress(input.token).toLowerCase(),
    escrow: getAddress(input.escrow).toLowerCase(),
    committee: getAddress(input.committee).toLowerCase(),
    vault: getAddress(input.vault).toLowerCase(),
    ...(input.workflowEscrow ? { workflowEscrow: getAddress(input.workflowEscrow).toLowerCase() } : {}),
  };
}

export function contractForMethod(method: TransactionMethod, contracts: ContractAllowlist): string {
  if (method === "faucet" || method === "approve") return contracts.token;
  if (method === "createWorkflowTask" || method === "resolveWorkflowTask") {
    if (!contracts.workflowEscrow) throw new Error("CHAIN_WORKFLOW_ESCROW_UNAVAILABLE");
    return contracts.workflowEscrow;
  }
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
  if (["createTask", "createWorkflowTask", "assignAgent", "acceptTask", "submitWork", "acceptWork", "timeoutTask", "openDispute", "castVote", "resolveWorkflowTask"].includes(method)) {
    bound.taskId = resource.taskId;
  }
  if (method === "createTask" || method === "createWorkflowTask") {
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
    const target = bound.target === "escrow" ? "escrow"
      : bound.target === "workflowEscrow" ? "workflowEscrow"
      : bound.target === "vault" ? "vault" : null;
    const requestedSpender = target === null ? bound.spender : contracts[target];
    const spender = typeof requestedSpender === "string" ? getAddress(requestedSpender).toLowerCase() : "";
    if (spender !== contracts.escrow && spender !== contracts.vault && spender !== contracts.workflowEscrow) throw new Error("CHAIN_SPENDER_FORBIDDEN");
    bound.spender = spender;
    if (target === "escrow") {
      if (record === undefined) throw new Error("CHAIN_RESOURCE_EXPECTATION_MISSING");
      bound.amountAtomic = record.budgetAtomic;
    } else if (target === "workflowEscrow") {
      if (record === undefined) throw new Error("CHAIN_RESOURCE_EXPECTATION_MISSING");
      const budget = BigInt(record.budgetAtomic);
      bound.amountAtomic = (budget + budget * 6n / 100n).toString();
    }
    delete bound.target;
  }
  return bound;
}
