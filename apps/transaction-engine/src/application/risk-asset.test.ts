import { describe,expect,it } from 'vitest';
import { RiskQuoteSchema } from '@agent-market/shared-contracts';
import { configuredRiskAsset } from './risk-asset';
import { fingerprintRiskTask,type AuthoritativeRiskTask } from './risk-pricing-service';
import { assessRisk,createRiskQuote } from './risk-engine';
const token='0x5555555555555555555555555555555555555555';
const asset=`eip155:11155111/erc20:${token}`;
const task: AuthoritativeRiskTask={id:'11111111-1111-4111-8111-111111111111',title:'Test',description:'Test',requirements:['Test'],declaredPermissions:[],durationHours:1,dependencyClasses:[],budgetAtomic:'1000',publisherWallet:token,authorizedQuoteWallets:[token],quoteStatus:'active',dag:null};
describe('asset-bound quote identity',()=>{
  it('derives identity only from the configured token and existing chain, without network access',()=>{
    expect(configuredRiskAsset({AGENT_MARKET_YD_TOKEN_ADDRESS:token})).toBe(asset);
    expect(()=>configuredRiskAsset({COMMERCIAL_ASSET_ID:asset})).toThrow('MISSING_AGENT_MARKET_YD_TOKEN_ADDRESS');
    for(const value of ['YD','0x123','0x'+'0'.repeat(40)]) expect(()=>configuredRiskAsset({AGENT_MARKET_YD_TOKEN_ADDRESS:value})).toThrow('INVALID_AGENT_MARKET_YD_TOKEN_ADDRESS');
    for(const value of ['YD',`eip155:1/erc20:${token}`,'eip155:11155111/erc20:0x6666666666666666666666666666666666666666']) expect(()=>configuredRiskAsset({AGENT_MARKET_YD_TOKEN_ADDRESS:token,COMMERCIAL_ASSET_ID:value})).toThrow('MISMATCH_COMMERCIAL_ASSET_ID');
  });
  it('includes chain and contract in canonical task identity and preserves legacy read-only parsing',()=>{
    expect(fingerprintRiskTask(task,asset)).not.toBe(fingerprintRiskTask(task));
    expect(fingerprintRiskTask(task,asset)).not.toBe(fingerprintRiskTask(task,`eip155:1/erc20:${token}`));
    expect(fingerprintRiskTask(task,asset)).not.toBe(fingerprintRiskTask(task,'eip155:11155111/erc20:0x6666666666666666666666666666666666666666'));
    const quote=createRiskQuote({assetId:asset,phase:'preliminary',policyVersion:'risk-pricing-v2',taskFingerprint:fingerprintRiskTask(task,asset),budgetAtomic:'1000',serviceFeeBps:600,assessment:assessRisk({factors:{complexity:0,acceptanceAmbiguity:0,externalDependency:0,dataSensitivity:0,financialRisk:0,irreversibility:0,deadlineRisk:0,agentUncertainty:0},reasonCodes:['test_case']}),expiresAt:'2099-01-01T00:00:00.000Z'});
    expect(quote).toMatchObject({schemaVersion:2,assetId:asset});
    expect(RiskQuoteSchema.safeParse({...quote,assetId:undefined}).success).toBe(false);
    expect(RiskQuoteSchema.safeParse({...quote,schemaVersion:3}).success).toBe(false);
    const {assetId:_asset,schemaVersion:_version,...legacy}=quote;
    expect(RiskQuoteSchema.parse(legacy)).not.toHaveProperty('assetId');
  });
});
