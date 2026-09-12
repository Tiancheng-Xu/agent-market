import { getAddress } from 'ethers';
import { RiskAssetIdSchema, SEPOLIA_CHAIN_ID } from '@agent-market/shared-contracts';

/** Configuration identity only. No RPC, deployment or claim of token support. */
export function configuredRiskAsset(env: Record<string,string | undefined> = process.env): string {
  const token = env.AGENT_MARKET_YD_TOKEN_ADDRESS?.trim();
  if (!token) throw new Error('RISK_ASSET_CONFIG_MISSING_AGENT_MARKET_YD_TOKEN_ADDRESS');
  let address: string;
  try { address = getAddress(token).toLowerCase(); } catch { throw new Error('RISK_ASSET_CONFIG_INVALID_AGENT_MARKET_YD_TOKEN_ADDRESS'); }
  const parsed = RiskAssetIdSchema.safeParse(`eip155:${SEPOLIA_CHAIN_ID}/erc20:${address}`);
  if (!parsed.success) throw new Error('RISK_ASSET_CONFIG_INVALID_AGENT_MARKET_YD_TOKEN_ADDRESS');
  if (env.COMMERCIAL_ASSET_ID !== undefined && env.COMMERCIAL_ASSET_ID.trim() !== parsed.data) {
    throw new Error('RISK_ASSET_CONFIG_MISMATCH_COMMERCIAL_ASSET_ID');
  }
  return parsed.data;
}
