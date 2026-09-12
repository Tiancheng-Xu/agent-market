import { beforeEach, expect, it, vi } from "vitest";
import { AuthError } from "../auth/session";
import { handleGovernance } from "./http";
import { GovernanceError } from "./service";
const mocks = vi.hoisted(()=>({authenticateSession:vi.fn(),requireRecentAuth:vi.fn(),execute:vi.fn(),read:vi.fn(),readView:vi.fn()}));
vi.mock("../auth/runtime",()=>({getAuthOrigin:()=>new URL("https://market.test"),getAuthService:()=>mocks}));
vi.mock("./runtime",()=>({getGovernanceService:()=>mocks}));
beforeEach(()=>{
  vi.resetAllMocks();
  mocks.authenticateSession.mockResolvedValue({walletAddress:`0x${"1".repeat(40)}`});
  mocks.execute.mockResolvedValue({id:"event",status:"recorded"});
  mocks.read.mockResolvedValue([]);
});
const request = (origin="https://market.test",body=JSON.stringify({action:"event",severity:"P0",reason:"incident"}))=>new Request("https://market.test/api/governance/events",{
  method:"POST",headers:{origin,cookie:"__Host-agent_market_session=token","idempotency-key":"event-key-001"},body,
});
it("rejects cross-origin POST before authentication or mutation",async()=>{
  const response=await handleGovernance(request("https://attacker.test"),"events");
  expect(response.status).toBe(403);
  expect(mocks.authenticateSession).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("requires cookie and recent auth, and rejects malformed or routed-wrong commands",async()=>{
  expect((await handleGovernance(new Request("https://market.test/api/governance/audit"),"audit")).status).toBe(401);
  mocks.requireRecentAuth.mockImplementationOnce(()=>{throw new AuthError("AUTH_RECENT_REQUIRED",403);});
  expect((await handleGovernance(request(),"events")).status).toBe(403);
  expect((await handleGovernance(request("https://market.test","{"),"events")).status).toBe(400);
  expect((await handleGovernance(request(),"reviews")).status).toBe(400);
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("uses session identity, returns no-store and sanitizes infrastructure errors",async()=>{
  const response=await handleGovernance(request(),"events");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.execute.mock.calls[0]?.[0]).toBe(`0x${"1".repeat(40)}`);
  mocks.execute.mockRejectedValueOnce(new Error("postgres://secret@private"));
  const failed=await handleGovernance(request(),"events");
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("secret");
});
it("W4 exposes revoked authority and manual-review conflicts without a success envelope",async()=>{
  for (const [code,status] of [["GOVERNANCE_FORBIDDEN",403],["GOVERNANCE_MANUAL_REVIEW_REQUIRED",409]] as const) {
    mocks.execute.mockRejectedValueOnce(new GovernanceError(code,status));
    const response=await handleGovernance(request(),"events");
    expect(response.status).toBe(status);
    const body=await response.json();
    expect(body.error).toBe(code);
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(body).not.toHaveProperty("result");
  }
});
it("UI GET includes authoritative permissions and preserves review_context",async()=>{
  const view={items:[{id:"proposal",review_context:{from:"manual_review",to:"in_progress",version:2,expectedVersion:2}}],permissions:{walletAddress:`0x${"1".repeat(40)}`,operator:false,reviewer:true,source:"agent_market.governance_roles"}};
  mocks.readView.mockResolvedValueOnce(view);
  const response=await handleGovernance(new Request("https://market.test/api/governance/reviews",{headers:{cookie:"__Host-agent_market_session=token"}}),"reviews");
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject(view);
});

function streamedRequest(chunks:Uint8Array[],contentLength?:string){
  const cancel=vi.fn();let delivered=0;
  const body=new ReadableStream<Uint8Array>({pull(controller){const chunk=chunks[delivered++];if(chunk)controller.enqueue(chunk);else controller.close();},cancel},{highWaterMark:0});
  const headers=new Headers({origin:"https://market.test",cookie:"__Host-agent_market_session=token","idempotency-key":"stream-test-key"});
  if(contentLength!==undefined)headers.set("content-length",contentLength);
  const init:RequestInit & {duplex:"half"}={method:"POST",headers,body,duplex:"half"};
  return {request:new Request("https://market.test/api/governance/events",init),cancel,delivered:()=>delivered};
}
it.each([undefined,"1"])("stream limit rejects chunked overflow with absent or false content-length %s and cancels early",async length=>{
  const fixture=streamedRequest([new Uint8Array(8192),new Uint8Array(8192),new Uint8Array(1),new Uint8Array(4096)],length);
  const response=await handleGovernance(fixture.request,"events");
  expect(response.status).toBe(413);expect((await response.json()).error).toBe("GOVERNANCE_INPUT_TOO_LARGE");
  expect(fixture.cancel).toHaveBeenCalledTimes(1);expect(fixture.delivered()).toBe(3);
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("stream limit counts UTF8 bytes rather than JavaScript characters",async()=>{
  const encoded=new TextEncoder().encode(JSON.stringify({action:"event",severity:"P1",reason:"界".repeat(6000)}));
  const fixture=streamedRequest([encoded]);
  expect((await handleGovernance(fixture.request,"events")).status).toBe(413);
  expect(fixture.cancel).toHaveBeenCalledTimes(1);expect(mocks.execute).not.toHaveBeenCalled();
});
it("stream limit accepts exactly 16KiB and preserves multibyte characters split between chunks",async()=>{
  const reason="界🙂";
  const json=JSON.stringify({action:"event",severity:"P1",reason});
  const encoder=new TextEncoder();const encoded=encoder.encode(json+" ".repeat(16384-encoder.encode(json).byteLength));
  const chunks=Array.from({length:Math.ceil(encoded.length/17)},(_,i)=>encoded.slice(i*17,(i+1)*17));
  const fixture=streamedRequest(chunks);
  expect((await handleGovernance(fixture.request,"events")).status).toBe(200);
  expect(mocks.execute.mock.calls[0]?.[3]).toEqual({action:"event",severity:"P1",reason});
  expect(fixture.cancel).not.toHaveBeenCalled();
});
it("stream limit does not consume body before Origin and recent-auth checks",async()=>{
  const fixture=streamedRequest([new Uint8Array(20000)]);
  mocks.requireRecentAuth.mockImplementationOnce(()=>{throw new AuthError("AUTH_RECENT_REQUIRED",403);});
  expect((await handleGovernance(fixture.request,"events")).status).toBe(403);
  expect(fixture.delivered()).toBe(0);expect(mocks.execute).not.toHaveBeenCalled();
  const cross=streamedRequest([new Uint8Array(20000)]);cross.request.headers.set("origin","https://attacker.test");
  expect((await handleGovernance(cross.request,"events")).status).toBe(403);
  expect(cross.delivered()).toBe(0);
});

function pausedBody(){
  let start:()=>void=()=>{},controller:ReadableStreamDefaultController<Uint8Array>;
  const started=new Promise<void>(resolve=>{start=resolve;});
  const cancel=vi.fn();
  const stream=new ReadableStream<Uint8Array>({start(c){controller=c;},pull(){start();},cancel},{highWaterMark:0});
  const init:RequestInit & {duplex:"half"}={method:"POST",duplex:"half",body:stream,headers:{origin:"https://market.test",cookie:"__Host-agent_market_session=token","idempotency-key":"paused-test-key"}};
  return {request:new Request("https://market.test/api/governance/events",init),started,cancel,finish(){controller.enqueue(new TextEncoder().encode(JSON.stringify({action:"event",severity:"P1",reason:"test"})));controller.close();}};
}
it("body deadline reauth rejects session revoked while body is paused",async()=>{
  const fixture=pausedBody();const pending=handleGovernance(fixture.request,"events");await fixture.started;
  mocks.authenticateSession.mockRejectedValueOnce(new AuthError("AUTH_SESSION_INVALID"));
  fixture.finish();const response=await pending;
  expect(response.status).toBe(401);expect(mocks.authenticateSession).toHaveBeenCalledTimes(2);expect(mocks.execute).not.toHaveBeenCalled();
});
it("body deadline reauth rejects recent authentication expired during body reading",async()=>{
  const fixture=pausedBody();const pending=handleGovernance(fixture.request,"events");await fixture.started;
  mocks.requireRecentAuth.mockImplementationOnce(()=>{throw new AuthError("AUTH_RECENT_REQUIRED",403);});
  fixture.finish();const response=await pending;
  expect(response.status).toBe(403);expect(mocks.requireRecentAuth).toHaveBeenCalledTimes(2);expect(mocks.execute).not.toHaveBeenCalled();
});
it("body deadline reauth rejects a different wallet returned by the second authentication",async()=>{
  const fixture=pausedBody();const pending=handleGovernance(fixture.request,"events");await fixture.started;
  mocks.authenticateSession.mockResolvedValueOnce({walletAddress:`0x${"2".repeat(40)}`});
  fixture.finish();expect((await pending).status).toBe(401);expect(mocks.execute).not.toHaveBeenCalled();
});
it("body deadline cancels a stalled stream without awaiting unending cancel and clears timers",async()=>{
  vi.useFakeTimers();
  try{
    const fixture=pausedBody();fixture.cancel.mockImplementation(()=>new Promise(()=>{}));
    const pending=handleGovernance(fixture.request,"events");await fixture.started;
    await vi.advanceTimersByTimeAsync(5000);
    const response=await pending;
    expect(response.status).toBe(408);expect((await response.json()).error).toBe("GOVERNANCE_BODY_TIMEOUT");
    expect(fixture.cancel).toHaveBeenCalledTimes(1);expect(mocks.execute).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
});
it("body deadline clears timer after a successful bounded read and uses rechecked identity",async()=>{
  vi.useFakeTimers();
  try{
    const second={walletAddress:`0x${"1".repeat(40)}`};
    mocks.authenticateSession.mockResolvedValueOnce(second).mockResolvedValueOnce(second);
    expect((await handleGovernance(request(),"events")).status).toBe(200);
    expect(mocks.authenticateSession).toHaveBeenCalledTimes(2);expect(mocks.requireRecentAuth).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[0]?.[0]).toBe(second.walletAddress);expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
});
