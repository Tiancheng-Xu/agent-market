import {
  TransactionVerificationV1Schema,
  type TransactionIntentV1,
  type TransactionVerificationV1,
} from "@agent-market/shared-contracts";
import { ZeroAddress } from "ethers";

import {
  getTransactionMethodDefinition,
  type TransactionMethod,
} from "./intents";
import type { ChainTransactionExpectation } from "./resources";

export interface ChainLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface ChainTransaction {
  hash: string;
  chainId: number;
  from: string;
  to: string | null;
  data: string;
  valueAtomic: string;
  blockNumber: number;
  blockHash: string;
}

export interface ChainReceipt {
  status: "success" | "failed";
  blockNumber: number;
  blockHash: string;
  logs: readonly ChainLog[];
}

export interface ChainObservation {
  transaction: ChainTransaction | null;
  receipt: ChainReceipt | null;
  latestBlockNumber: number | null;
  canonicalBlockHash: string | null;
}

export interface ChainReader {
  readTransaction(txHash: string): Promise<ChainObservation | null>;
}

export interface ReconcileInput {
  intent: TransactionIntentV1;
  txHash: string;
  rpc: ChainReader;
  blockscout: ChainReader;
  minimumConfirmations?: number;
  checkedAt?: Date | string;
  previous?: TransactionVerificationV1;
  previousCanonicalBlockHash?: string;
  expectation?: ChainTransactionExpectation;
  onCanonicalObservation?: (observation: { blockHash: string; requestRef?: string }) => void;
}

type ErrorCode =
  | "FAILED_RECEIPT"
  | "WRONG_CHAIN"
  | "WRONG_TO"
  | "WRONG_SENDER"
  | "WRONG_SELECTOR"
  | "WRONG_REQUEST_REF"
  | "WRONG_AMOUNT"
  | "TRANSACTION_DATA_MISMATCH"
  | "EVENT_MISMATCH";

const lower = (value: string): string => value.toLowerCase();

function checkedAt(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error("Invalid checkedAt timestamp");
  return date.toISOString();
}

function verifying(
  input: ReconcileInput,
  at: string,
  confirmations = 0,
  blockNumber: number | null = null,
): TransactionVerificationV1 {
  return TransactionVerificationV1Schema.parse({
    intentId: input.intent.intentId,
    requestId: input.intent.requestId,
    txHash: input.txHash,
    checkedAt: at,
    status: "verifying",
    confirmations,
    blockNumber,
  });
}

function failed(
  input: ReconcileInput,
  at: string,
  errorCode: ErrorCode,
  confirmations: number,
  blockNumber: number,
): TransactionVerificationV1 {
  return TransactionVerificationV1Schema.parse({
    intentId: input.intent.intentId,
    requestId: input.intent.requestId,
    txHash: input.txHash,
    checkedAt: at,
    status: "failed",
    confirmations,
    blockNumber,
    errorCode,
  });
}

function coreTransactionEqual(a: ChainObservation, b: ChainObservation): boolean {
  const left = a.transaction!;
  const right = b.transaction!;
  return (
    lower(left.hash) === lower(right.hash) &&
    left.chainId === right.chainId &&
    lower(left.from) === lower(right.from) &&
    lower(left.to ?? "") === lower(right.to ?? "") &&
    lower(left.data) === lower(right.data) &&
    left.valueAtomic === right.valueAtomic &&
    left.blockNumber === right.blockNumber &&
    lower(left.blockHash) === lower(right.blockHash)
  );
}

function receiptsEqual(a: ChainReceipt, b: ChainReceipt): boolean {
  return (
    a.status === b.status &&
    a.blockNumber === b.blockNumber &&
    lower(a.blockHash) === lower(b.blockHash)
  );
}

function normalizedArgument(value: unknown): string {
  if (typeof value === "string") return lower(value);
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

function calldataError(intent: TransactionIntentV1, actualData: string): ErrorCode | null {
  const expected = lower(intent.data);
  const actual = lower(actualData);
  if (expected === actual) return null;
  if (expected.slice(0, 10) !== actual.slice(0, 10)) return "WRONG_SELECTOR";

  const { contractInterface, functionName } = getTransactionMethodDefinition(
    intent.method as TransactionMethod,
  );
  try {
    const expectedArgs = contractInterface.decodeFunctionData(functionName, expected);
    const actualArgs = contractInterface.decodeFunctionData(functionName, actual);
    if (
      (intent.method === "createTask" || intent.method === "createWorkflowTask") &&
      normalizedArgument(expectedArgs[1]) !== normalizedArgument(actualArgs[1])
    ) {
      return "WRONG_REQUEST_REF";
    }
    const amountIndex =
      intent.method === "approve" ||
      intent.method === "stake" ||
      intent.method === "unstake"
        ? intent.method === "approve"
          ? 1
          : 0
        : intent.method === "createTask" || intent.method === "createWorkflowTask"
          ? 2
          : null;
    if (
      amountIndex !== null &&
      normalizedArgument(expectedArgs[amountIndex]) !==
        normalizedArgument(actualArgs[amountIndex])
    ) {
      return "WRONG_AMOUNT";
    }
  } catch {
    return "TRANSACTION_DATA_MISMATCH";
  }
  return "TRANSACTION_DATA_MISMATCH";
}

function matchingEvent(
  intent: TransactionIntentV1,
  receipt: ChainReceipt,
): { log: ChainLog; args: readonly unknown[] } | null {
  const { contractInterface, eventName } = getTransactionMethodDefinition(
    intent.method as TransactionMethod,
  );
  for (const log of receipt.logs) {
    if (lower(log.address) !== lower(intent.to)) continue;
    try {
      const parsed = contractInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === eventName) return { log, args: parsed.args };
    } catch {
      // A receipt may contain unrelated logs from token transfers or nested calls.
    }
  }
  return null;
}

function eventError(
  intent: TransactionIntentV1,
  args: readonly unknown[],
  expectation?: ChainTransactionExpectation,
): ErrorCode | null {
  const { contractInterface, functionName } = getTransactionMethodDefinition(
    intent.method as TransactionMethod,
  );
  const callArgs = contractInterface.decodeFunctionData(functionName, intent.data);
  const eq = (left: unknown, right: unknown): boolean =>
    normalizedArgument(left) === normalizedArgument(right);

  switch (intent.method) {
    case "faucet":
      return eq(args[0], ZeroAddress) && eq(args[1], intent.from)
        && eq(args[2], "1000000000000000000000")
        ? null
        : "EVENT_MISMATCH";
    case "approve":
      if (!eq(args[0], intent.from) || !eq(args[1], callArgs[0])) return "EVENT_MISMATCH";
      return eq(args[2], callArgs[1]) ? null : "WRONG_AMOUNT";
    case "createTask":
      if (!eq(args[1], intent.requestRef)) return "WRONG_REQUEST_REF";
      if (!eq(args[0], callArgs[0]) || !eq(args[2], intent.from)) return "EVENT_MISMATCH";
      if (!eq(args[3], callArgs[2])) return "WRONG_AMOUNT";
      return eq(args[4], callArgs[3]) ? null : "EVENT_MISMATCH";
    case "createWorkflowTask":
      if (!eq(args[1], intent.requestRef)) return "WRONG_REQUEST_REF";
      if (!eq(args[0], callArgs[0]) || !eq(args[2], intent.from)) return "EVENT_MISMATCH";
      if (!eq(args[3], callArgs[2])) return "WRONG_AMOUNT";
      if (expectation === undefined || !eq(args[4], expectation.bondAtomic)) return "WRONG_AMOUNT";
      return eq(args[5], callArgs[3]) ? null : "EVENT_MISMATCH";
    case "assignAgent":
      if (!eq(args[1], intent.requestRef)) return "WRONG_REQUEST_REF";
      return eq(args[0], callArgs[0]) && eq(args[2], callArgs[1])
        ? null
        : "EVENT_MISMATCH";
    case "acceptTask":
      if (!eq(args[1], intent.requestRef) || !eq(args[0], callArgs[0])) return "EVENT_MISMATCH";
      return expectation !== undefined && eq(args[2], expectation.bondAtomic) ? null : "WRONG_AMOUNT";
    case "submitWork":
    case "openDispute":
      if (!eq(args[1], intent.requestRef)) return "WRONG_REQUEST_REF";
      return eq(args[0], callArgs[0]) ? null : "EVENT_MISMATCH";
    case "acceptWork":
    case "timeoutTask":
      if (!eq(args[1], intent.requestRef) || !eq(args[0], callArgs[0])) return "EVENT_MISMATCH";
      if (expectation === undefined || typeof args[2] !== "boolean"
        || args[2] !== expectation.agentWins) return "EVENT_MISMATCH";
      return eq(args[3], expectation.budgetAtomic) && eq(args[4], expectation.bondAtomic)
        ? null : "WRONG_AMOUNT";
    case "castVote":
      return eq(args[0], callArgs[0]) && eq(args[1], intent.from) && eq(args[2], callArgs[1])
        ? null
        : "EVENT_MISMATCH";
    case "resolveWorkflowTask":
      if (!eq(args[0], callArgs[0]) || args[1] !== callArgs[1] || !eq(args[2], intent.from)) return "EVENT_MISMATCH";
      return expectation !== undefined && eq(args[3], expectation.budgetAtomic) ? null : "WRONG_AMOUNT";
    case "stake":
    case "unstake":
      if (!eq(args[0], intent.from)) return "EVENT_MISMATCH";
      return eq(args[1], callArgs[0]) ? null : "WRONG_AMOUNT";
    case "claimYield":
      return eq(args[0], intent.from) ? null : "EVENT_MISMATCH";
  }
}

function observedRequestRef(method: TransactionMethod, args: readonly unknown[]): string | undefined {
  return ["createTask", "createWorkflowTask", "assignAgent", "acceptTask", "submitWork", "acceptWork", "timeoutTask", "openDispute"]
    .includes(method) && typeof args[1] === "string" ? lower(args[1]) : undefined;
}

export async function reconcileTransaction(
  input: ReconcileInput,
): Promise<TransactionVerificationV1> {
  const at = checkedAt(input.checkedAt);
  const minimumConfirmations = input.minimumConfirmations ?? 2;
  if (!Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1) {
    throw new Error("minimumConfirmations must be a positive safe integer");
  }

  const txHash = lower(input.txHash);
  let rpc: ChainObservation | null;
  let blockscout: ChainObservation | null;
  try {
    [rpc, blockscout] = await Promise.all([
      input.rpc.readTransaction(txHash),
      input.blockscout.readTransaction(txHash),
    ]);
  } catch {
    return verifying(input, at);
  }

  if (
    !rpc?.transaction ||
    !rpc.receipt ||
    rpc.latestBlockNumber === null ||
    !rpc.canonicalBlockHash ||
    !blockscout?.transaction ||
    !blockscout.receipt ||
    blockscout.latestBlockNumber === null ||
    !blockscout.canonicalBlockHash
  ) {
    return verifying(input, at);
  }

  if (!coreTransactionEqual(rpc, blockscout) || !receiptsEqual(rpc.receipt, blockscout.receipt)) {
    return verifying(input, at);
  }

  const transaction = rpc.transaction;
  const receipt = rpc.receipt;
  const confirmations = Math.max(
    0,
    Math.min(rpc.latestBlockNumber, blockscout.latestBlockNumber) - receipt.blockNumber + 1,
  );

  const currentBlockHash = lower(receipt.blockHash);
  const priorBlockHash = input.previousCanonicalBlockHash?.toLowerCase();
  if (
    (input.previous?.status === "confirmed" && priorBlockHash && priorBlockHash !== currentBlockHash) ||
    lower(transaction.blockHash) !== currentBlockHash ||
    transaction.blockNumber !== receipt.blockNumber ||
    lower(rpc.canonicalBlockHash) !== currentBlockHash ||
    lower(blockscout.canonicalBlockHash) !== currentBlockHash
  ) {
    return TransactionVerificationV1Schema.parse({
      intentId: input.intent.intentId,
      requestId: input.intent.requestId,
      txHash,
      checkedAt: at,
      status: "reorged",
      confirmations: 0,
      blockNumber: receipt.blockNumber,
      errorCode: "CHAIN_REORG",
    });
  }

  const deterministicError =
    (transaction.chainId !== input.intent.chainId && "WRONG_CHAIN") ||
    (lower(transaction.to ?? "") !== lower(input.intent.to) && "WRONG_TO") ||
    (lower(transaction.from) !== lower(input.intent.from) && "WRONG_SENDER") ||
    (transaction.valueAtomic !== input.intent.valueAtomic && "WRONG_AMOUNT") ||
    calldataError(input.intent, transaction.data);
  if (deterministicError) {
    return failed(
      input,
      at,
      deterministicError as ErrorCode,
      confirmations,
      receipt.blockNumber,
    );
  }
  if (receipt.status === "failed") {
    return failed(input, at, "FAILED_RECEIPT", confirmations, receipt.blockNumber);
  }

  const rpcEvent = matchingEvent(input.intent, rpc.receipt);
  const blockscoutEvent = matchingEvent(input.intent, blockscout.receipt);
  if (!rpcEvent || !blockscoutEvent) {
    return failed(input, at, "EVENT_MISMATCH", confirmations, receipt.blockNumber);
  }
  if (
    lower(rpcEvent.log.address) !== lower(blockscoutEvent.log.address) ||
    lower(rpcEvent.log.data) !== lower(blockscoutEvent.log.data) ||
    rpcEvent.log.topics.map(lower).join(":") !== blockscoutEvent.log.topics.map(lower).join(":")
  ) {
    return verifying(input, at, confirmations, receipt.blockNumber);
  }
  const invalidEvent = eventError(input.intent, rpcEvent.args, input.expectation);
  if (invalidEvent) {
    return failed(input, at, invalidEvent, confirmations, receipt.blockNumber);
  }
  const eventRequestRef = observedRequestRef(input.intent.method as TransactionMethod, rpcEvent.args);
  if (eventRequestRef === undefined) {
    input.onCanonicalObservation?.({ blockHash: currentBlockHash });
  } else {
    input.onCanonicalObservation?.({ blockHash: currentBlockHash, requestRef: eventRequestRef });
  }
  if (confirmations < minimumConfirmations) {
    return verifying(input, at, confirmations, receipt.blockNumber);
  }

  return TransactionVerificationV1Schema.parse({
    intentId: input.intent.intentId,
    requestId: input.intent.requestId,
    txHash,
    checkedAt: at,
    status: "confirmed",
    confirmations,
    blockNumber: receipt.blockNumber,
    eventName: getTransactionMethodDefinition(input.intent.method as TransactionMethod).eventName,
  });
}
