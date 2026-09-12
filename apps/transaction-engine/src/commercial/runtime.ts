import postgres from 'postgres';
import { CommercialService, type Database, type Query } from './service';
import { commercialRiskMaterial, loadCommercialRiskTask } from './risk-source';
import { configuredRiskAsset } from '../application/risk-asset';
let service: CommercialService | undefined;

export function commercialDatabase(sql: ReturnType<typeof postgres>): Database {
  const query: Query = async (text, values = []) => [...await sql.unsafe(text, values as never[])];
  return { query, transaction: fn => sql.begin(async tx => {
    const query: Query = async (text, values = []) => [...await tx.unsafe(text, values as never[])];
    query.riskTask = id => loadCommercialRiskTask(query,id);
    query.riskMaterial = id => commercialRiskMaterial(query,id);
    return fn(query);
  }) as Promise<Awaited<ReturnType<typeof fn>>> };
}
export function getCommercialService(): CommercialService {
  if (service) return service;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('COMMERCIAL_STORE_UNAVAILABLE');
  const assetId = configuredRiskAsset();
  const platformWallet = process.env.COMMERCIAL_PLATFORM_WALLET?.trim() ?? '';
  const sql = postgres(url, { max: 5, prepare: false, connect_timeout: 5 });
  // Fee and collateral amounts come only from the accepted risk quote.
  service = new CommercialService(commercialDatabase(sql), { assetId, platformWallet, feeBps: 0 });
  // Audited funding, yield consent and independent adjudication readers remain
  // unconfigured. No network funds action or simulated-success fallback exists.
  return service;
}
