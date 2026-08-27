import { z } from "zod";

import { SEPOLIA_CHAIN_ID, WalletAddressSchema } from "./auth";

const Bytes32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .transform((value) => value.toLowerCase());
const HexDataSchema = z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/);

export const TransactionMethodSchema = z.enum([
  "faucet",
  "approve",
  "createTask",
  "createWorkflowTask",
  "assignAgent",
  "acceptTask",
  "submitWork",
  "acceptWork",
  "timeoutTask",
  "openDispute",
  "castVote",
  "resolveWorkflowTask",
  "stake",
  "unstake",
  "claimYield",
]);

export const TransactionIntentV1Schema = z.strictObject({
  intentId: z.string().uuid(),
  requestId: z.string().uuid(),
  requestRef: Bytes32Schema,
  chainId: z.literal(SEPOLIA_CHAIN_ID),
  from: WalletAddressSchema,
  to: WalletAddressSchema,
  method: TransactionMethodSchema,
  data: HexDataSchema,
  valueAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const TransactionVerificationStatusSchema = z.enum([
  "verifying",
  "confirmed",
  "failed",
  "reorged",
]);

const TransactionVerificationBaseSchema = z.strictObject({
  intentId: z.string().uuid(),
  requestId: z.string().uuid(),
  txHash: Bytes32Schema,
  checkedAt: z.string().datetime(),
});

export const TransactionVerificationV1Schema = z.discriminatedUnion("status", [
  TransactionVerificationBaseSchema.extend({
    status: z.literal("verifying"),
    confirmations: z.number().int().nonnegative(),
    blockNumber: z.number().int().nonnegative().nullable(),
  }),
  TransactionVerificationBaseSchema.extend({
    status: z.literal("confirmed"),
    confirmations: z.number().int().positive(),
    blockNumber: z.number().int().nonnegative(),
    eventName: z.string().min(1).max(96),
  }),
  TransactionVerificationBaseSchema.extend({
    status: z.literal("failed"),
    confirmations: z.number().int().nonnegative(),
    blockNumber: z.number().int().nonnegative().nullable(),
    errorCode: z.string().min(1).max(96),
  }),
  TransactionVerificationBaseSchema.extend({
    status: z.literal("reorged"),
    confirmations: z.literal(0),
    blockNumber: z.number().int().nonnegative().nullable(),
    errorCode: z.literal("CHAIN_REORG"),
  }),
]);

export type TransactionIntentV1 = z.infer<typeof TransactionIntentV1Schema>;
export type TransactionVerificationV1 = z.infer<
  typeof TransactionVerificationV1Schema
>;
