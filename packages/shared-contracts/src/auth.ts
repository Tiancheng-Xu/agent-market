import { z } from "zod";

export const SEPOLIA_CHAIN_ID = 11_155_111 as const;

export const WalletAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .transform((address) => address.toLowerCase());

export const WalletChallengeV1Schema = z.strictObject({
  challengeId: z.string().uuid(),
  requestId: z.string().uuid(),
  walletAddress: WalletAddressSchema,
  chainId: z.literal(SEPOLIA_CHAIN_ID),
  nonce: z.string().min(16).max(96),
  domain: z.string().min(1).max(253),
  uri: z.string().url(),
  statement: z.string().min(1).max(240),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const WalletSessionV1Schema = z.strictObject({
  sessionId: z.string().uuid(),
  requestId: z.string().uuid(),
  walletAddress: WalletAddressSchema,
  chainId: z.literal(SEPOLIA_CHAIN_ID),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  recentAuthAt: z.string().datetime(),
});

export type WalletChallengeV1 = z.infer<typeof WalletChallengeV1Schema>;
export type WalletSessionV1 = z.infer<typeof WalletSessionV1Schema>;
