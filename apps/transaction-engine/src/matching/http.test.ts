import { describe, expect, it, vi } from "vitest";
import { assertSeparateVrfChainReaderCredentials, matchingHandler } from "./http";
import { parseMatchingCommand, type MatchingService } from "./service";
import { AuthError, type WalletAuthService } from "../auth/session";
const task="33333333-3333-4333-8333-333333333333";
const wallet="0x"+"1".repeat(40);
function fixture() {
  const configure=vi.fn(async (_actor:string,_id:string,input:unknown)=>{parseMatchingCommand(input);return {status:"pending",fairnessVerified:false}});
  const refresh=vi.fn(async()=>({status:"verified",fairnessVerified:true}));
  const status=vi.fn(async()=>({status:"pending",fairnessVerified:false}));
  const authenticateSession=vi.fn(async()=>({walletAddress:wallet}));
  const requireRecentAuth=vi.fn();
  const handler=matchingHandler({origin:new URL("https://te.example"),auth:{authenticateSession,requireRecentAuth} as unknown as WalletAuthService,
    service:{configure,refresh,status,setAccess:vi.fn()} as unknown as MatchingService});
  return {handler,configure,refresh,status,authenticateSession,requireRecentAuth};
}
function request(body:unknown,origin="https://te.example") {
  return new Request("https://te.example/api/tasks/"+task+"/selection",{method:"POST",headers:{origin,"content-type":"application/json",cookie:"__Host-agent_market_session=test-session"},body:JSON.stringify(body)});
}
function getRequest() {
  return new Request("https://te.example/api/tasks/"+task+"/selection",{headers:{cookie:"__Host-agent_market_session=test-session"}});
}
describe("matching authorization HTTP boundary",()=>{
  it("rejects foreign origins before any service or session lookup",async()=>{
    const f=fixture();expect((await f.handler(request({mode:"ranked",expectedVersion:1},"https://evil.example"),task,"task")).status).toBe(403);
    expect(f.authenticateSession).not.toHaveBeenCalled();expect(f.configure).not.toHaveBeenCalled();
  });
  it("rejects missing sessions before invoking matching",async()=>{
    const f=fixture();const r=request({mode:"ranked",expectedVersion:1});r.headers.delete("cookie");
    expect((await f.handler(r,task,"task")).status).toBe(401);expect(f.configure).not.toHaveBeenCalled();
  });
  it("passes only the authenticated principal; rejects client pool and actor overrides",async()=>{
    const f=fixture();const ok=await f.handler(request({mode:"vrf-exploration",expectedVersion:1}),task,"task");
    expect(ok.status).toBe(200);expect(f.configure).toHaveBeenCalledWith(wallet,task,{mode:"vrf-exploration",expectedVersion:1});
    const bad=await f.handler(request({mode:"vrf-exploration",expectedVersion:1,candidates:["fake"],actor:"admin"}),task,"task");
    expect(bad.status).toBe(400);
  });
  it("keeps GET read-only and reserves oracle refresh for an explicit same-origin POST",async()=>{
    const f=fixture();
    expect((await f.handler(getRequest(),task,"task")).status).toBe(200);
    expect(f.status).toHaveBeenCalledWith(wallet,task);
    expect(f.configure).not.toHaveBeenCalled();expect(f.refresh).not.toHaveBeenCalled();

    expect((await f.handler(request({action:"refresh"}),task,"task")).status).toBe(200);
    expect(f.refresh).toHaveBeenCalledWith(wallet,task);
    expect(f.configure).not.toHaveBeenCalled();
  });
  it("allows a valid non-recent publisher session to read selection status",async()=>{
    const f=fixture();
    f.requireRecentAuth.mockImplementation(()=>{throw new AuthError("AUTH_RECENT_REQUIRED",401)});
    const response=await f.handler(getRequest(),task,"task");
    expect(response.status).toBe(200);
    expect(f.status).toHaveBeenCalledWith(wallet,task);
    expect(f.requireRecentAuth).not.toHaveBeenCalled();
  });
  it("rejects writes from a valid but non-recent publisher session",async()=>{
    const f=fixture();
    f.requireRecentAuth.mockImplementation(()=>{throw new AuthError("AUTH_RECENT_REQUIRED",401)});
    const response=await f.handler(request({mode:"ranked",expectedVersion:1}),task,"task");
    expect(response.ok).toBe(false);
    expect(f.requireRecentAuth).toHaveBeenCalledOnce();
    expect(f.configure).not.toHaveBeenCalled();
  });
});

describe("VRF chain-reader database credentials",()=>{
  it("normalizes the database endpoint and rejects reused credentials without exposing either URL",()=>{
    const primary="postgres://runtime:p%40ss@DB.EXAMPLE/agent_market";
    const reader="postgresql://runtime:different-secret@db.example:5432/agent_market?sslmode=require";
    expect(()=>assertSeparateVrfChainReaderCredentials(primary,reader))
      .toThrowError("VRF_CHAIN_READER_CREDENTIAL_REUSE");
  });
  it("accepts a dedicated reader identity and fails closed on malformed configuration",()=>{
    expect(()=>assertSeparateVrfChainReaderCredentials(
      "postgres://runtime:app-secret@db.example/agent_market",
      "postgres://vrf_reader:reader-secret@db.example/agent_market",
    )).not.toThrow();
    expect(()=>assertSeparateVrfChainReaderCredentials(
      "postgres://runtime:app-secret@db.example/agent_market","not-a-database-url",
    )).toThrowError("MATCH_DATABASE_CONFIGURATION_INVALID");
  });
});
