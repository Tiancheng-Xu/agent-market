import {
  SEPOLIA_CHAIN_ID,
  TransactionIntentV1Schema,
  type TransactionIntentV1,
} from "@agent-market/shared-contracts";
import { Interface } from "ethers";
import { randomUUID } from "node:crypto";

const METHOD_ABI = {
  faucet: [
    "function faucet()",
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ],
  approve: [
    "function approve(address spender,uint256 value) returns (bool)",
    "event Approval(address indexed owner,address indexed spender,uint256 value)",
  ],
  createTask: [
    "function createTask(bytes32 taskId,bytes32 requestRef,uint256 budget,uint64 deadline)",
    "event TaskCreated(bytes32 indexed taskId,bytes32 indexed requestRef,address indexed publisher,uint256 budget,uint64 deadline)",
  ],
  createWorkflowTask: [
    "function createTask(bytes32 taskId,bytes32 requestRef,uint256 budget,uint64 deadline)",
    "event TaskCreated(bytes32 indexed taskId,bytes32 indexed requestRef,address indexed publisher,uint256 budget,uint256 publicationFee,uint64 deadline)",
  ],
  assignAgent: [
    "function assignAgent(bytes32 taskId,address agent)",
    "event AgentAssigned(bytes32 indexed taskId,bytes32 indexed requestRef,address indexed agent)",
  ],
  acceptTask: [
    "function acceptTask(bytes32 taskId)",
    "event TaskAccepted(bytes32 indexed taskId,bytes32 indexed requestRef,uint256 bond,uint64 startedAt)",
  ],
  submitWork: [
    "function submitWork(bytes32 taskId)",
    "event WorkSubmitted(bytes32 indexed taskId,bytes32 indexed requestRef)",
  ],
  acceptWork: [
    "function acceptWork(bytes32 taskId)",
    "event TaskSettled(bytes32 indexed taskId,bytes32 indexed requestRef,bool agentWins,uint256 budgetPaid,uint256 bondPaidToPlatform,uint256 yieldPaid,uint256 yieldShortfall)",
  ],
  timeoutTask: [
    "function timeoutTask(bytes32 taskId)",
    "event TaskSettled(bytes32 indexed taskId,bytes32 indexed requestRef,bool agentWins,uint256 budgetPaid,uint256 bondPaidToPlatform,uint256 yieldPaid,uint256 yieldShortfall)",
  ],
  openDispute: [
    "function openDispute(bytes32 taskId)",
    "event DisputeOpened(bytes32 indexed taskId,bytes32 indexed requestRef)",
  ],
  castVote: [
    "function castVote(bytes32 taskId,bool agentWins)",
    "event VoteCast(bytes32 indexed taskId,address indexed voter,bool agentWins)",
  ],
  resolveWorkflowTask: [
    "function resolveTask(bytes32 taskId,bool agentsWin)",
    "event TaskResolved(bytes32 indexed taskId,bool agentsWin,address indexed arbiter,uint256 budget)",
  ],
  stake: [
    "function stake(uint256 amount)",
    "event Staked(address indexed account,uint256 amount)",
  ],
  unstake: [
    "function unstake(uint256 amount)",
    "event Unstaked(address indexed account,uint256 amount)",
  ],
  claimYield: [
    "function claimYield() returns (uint256 amount)",
    "event YieldClaimed(address indexed account,uint256 amount)",
  ],
} as const;

export type TransactionMethod = keyof typeof METHOD_ABI;

const EVENT_BY_METHOD: Record<TransactionMethod, string> = {
  faucet: "Transfer",
  approve: "Approval",
  createTask: "TaskCreated",
  createWorkflowTask: "TaskCreated",
  assignAgent: "AgentAssigned",
  acceptTask: "TaskAccepted",
  submitWork: "WorkSubmitted",
  acceptWork: "TaskSettled",
  timeoutTask: "TaskSettled",
  openDispute: "DisputeOpened",
  castVote: "VoteCast",
  resolveWorkflowTask: "TaskResolved",
  stake: "Staked",
  unstake: "Unstaked",
  claimYield: "YieldClaimed",
};

const INTERFACES = Object.fromEntries(
  Object.entries(METHOD_ABI).map(([method, abi]) => [method, new Interface(abi)]),
) as Record<TransactionMethod, Interface>;

export type IntentArguments = {
  faucet: Record<string, never>;
  approve: { spender: string; amountAtomic: string };
  createTask: { taskId: string; budgetAtomic: string; deadline: number | bigint };
  createWorkflowTask: { taskId: string; budgetAtomic: string; deadline: number | bigint };
  assignAgent: { taskId: string; agent: string };
  acceptTask: { taskId: string };
  submitWork: { taskId: string };
  acceptWork: { taskId: string };
  timeoutTask: { taskId: string };
  openDispute: { taskId: string };
  castVote: { taskId: string; agentWins: boolean };
  resolveWorkflowTask: { taskId: string; agentsWin: boolean };
  stake: { amountAtomic: string };
  unstake: { amountAtomic: string };
  claimYield: Record<string, never>;
};

type IntentBase = {
  intentId?: string;
  requestId: string;
  requestRef: string;
  from: string;
  to: string;
  createdAt?: Date | string;
  expiresAt?: Date | string;
  validityMs?: number;
};

export type BuildIntentInput = {
  [Method in TransactionMethod]: IntentBase & {
    method: Method;
    args: IntentArguments[Method];
  };
}[TransactionMethod];

export function getTransactionMethodDefinition(method: TransactionMethod): {
  contractInterface: Interface;
  eventName: string;
  functionName: string;
} {
  return {
    contractInterface: INTERFACES[method],
    eventName: EVENT_BY_METHOD[method],
    functionName: method === "createWorkflowTask" ? "createTask"
      : method === "resolveWorkflowTask" ? "resolveTask" : method,
  };
}

function encodeArguments(input: BuildIntentInput): readonly unknown[] {
  switch (input.method) {
    case "faucet":
    case "claimYield":
      return [];
    case "approve":
      return [input.args.spender, input.args.amountAtomic];
    case "createTask":
    case "createWorkflowTask":
      return [
        input.args.taskId,
        input.requestRef,
        input.args.budgetAtomic,
        input.args.deadline,
      ];
    case "assignAgent":
      return [input.args.taskId, input.args.agent];
    case "acceptTask":
    case "submitWork":
    case "acceptWork":
    case "timeoutTask":
    case "openDispute":
      return [input.args.taskId];
    case "castVote":
      return [input.args.taskId, input.args.agentWins];
    case "resolveWorkflowTask":
      return [input.args.taskId, input.args.agentsWin];
    case "stake":
    case "unstake":
      return [input.args.amountAtomic];
  }
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid intent timestamp");
  return date.toISOString();
}

export function buildTransactionIntent(input: BuildIntentInput): TransactionIntentV1 {
  const createdAt = iso(input.createdAt ?? new Date());
  const validityMs = input.validityMs ?? 10 * 60 * 1_000;
  if (!Number.isSafeInteger(validityMs) || validityMs <= 0) {
    throw new Error("validityMs must be a positive safe integer");
  }
  const expiresAt = iso(
    input.expiresAt ?? new Date(new Date(createdAt).getTime() + validityMs),
  );
  if (new Date(expiresAt).getTime() <= new Date(createdAt).getTime()) {
    throw new Error("Intent expiry must be after creation");
  }

  const definition = getTransactionMethodDefinition(input.method);
  const data = definition.contractInterface
    .encodeFunctionData(definition.functionName, encodeArguments(input))
    .toLowerCase();

  return TransactionIntentV1Schema.parse({
    intentId: input.intentId ?? randomUUID(),
    requestId: input.requestId,
    requestRef: input.requestRef,
    chainId: SEPOLIA_CHAIN_ID,
    from: input.from,
    to: input.to,
    method: input.method,
    data,
    valueAtomic: "0",
    createdAt,
    expiresAt,
  });
}
