import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { withWalletSession } from "../lib/walletSession";
import { GovernanceClient, GovernanceController, canReview, type GovernanceView } from "./client";
import { GovernancePanel, ReviewPreview } from "./GovernancePanel";

const wallet=`0x${"1".repeat(40)}`;
// Simulate successful sign-in locally; no wallet or network authentication runs.
beforeEach(async()=>{await withWalletSession(async()=>{});});
const view: GovernanceView={items:[],permissions:{walletAddress:wallet,operator:false,reviewer:false,source:"agent_market.governance_roles"},requestId:"read-1"};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
it("client includes cookie and stable idempotency key, never requests a transaction",async()=>{
  const fetcher=vi.fn().mockResolvedValue(reply({result:{status:"recorded"},requestId:"post-1"}));
  const client=new GovernanceClient(wallet,fetcher,()=>0);
  await client.write("events",{action:"event",severity:"P1",reason:"incident"},"stable-key-001");
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/governance/events");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({method:"POST",credentials:"include",headers:{"Idempotency-Key":"stable-key-001"}});
});
it("403 clears data and permissions; late data cannot restore revoked state",async()=>{
  let release: (r:Response)=>void=()=>{};
  const late=new Promise<Response>(resolve=>{release=resolve;});
  const fetcher=vi.fn().mockResolvedValueOnce(reply({...view,items:[{id:"sensitive"}]})).mockReturnValueOnce(late).mockResolvedValueOnce(reply({error:"GOVERNANCE_FORBIDDEN",requestId:"denied"},403));
  const controller=new GovernanceController(new GovernanceClient(wallet,fetcher,()=>0));
  await controller.load("reviews");
  const pending=controller.load("audit");
  await controller.load("events");
  expect(controller.snapshot().items).toEqual([]);
  expect(controller.snapshot().permissions).toBeNull();
  expect(controller.snapshot().error?.status).toBe(403);
  release(reply({...view,items:[{id:"late-secret"}]})); await pending;
  expect(controller.snapshot().items).toEqual([]);
});
it("409 keeps the conflict visible and refreshes the current resource; success refreshes",async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(reply(view))
    .mockResolvedValueOnce(reply({error:"GOVERNANCE_MANUAL_REVIEW_REQUIRED"},409)).mockResolvedValueOnce(reply(view))
    .mockResolvedValueOnce(reply({result:{status:"recorded"},requestId:"success"})).mockResolvedValueOnce(reply(view));
  const controller=new GovernanceController(new GovernanceClient(wallet,fetcher,()=>0));
  await controller.load("reviews");
  await controller.write("commands",{action:"resume"});
  expect(controller.snapshot().error?.code).toBe("GOVERNANCE_MANUAL_REVIEW_REQUIRED");
  await controller.write("events",{action:"event"});
  expect(controller.snapshot().message).toContain("recorded");
  expect(fetcher).toHaveBeenCalledTimes(5);
});
it("account revision rejects an in-flight response and clears prior data",async()=>{
  let revision=0;
  const fetcher=vi.fn(async()=>{revision++;return reply(view);});
  const controller=new GovernanceController(new GovernanceClient(wallet,fetcher,()=>revision));
  await controller.load("reviews");
  expect(controller.snapshot().items).toEqual([]);
  expect(controller.snapshot().error?.code).toBe("AUTH_WALLET_CHANGED");
});
it("uncertain POST retry retains its key and cookie identity mismatch never exposes rows",async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(reply(view)).mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(reply({result:{status:"recorded"}})).mockResolvedValueOnce(reply(view));
  const controller=new GovernanceController(new GovernanceClient(wallet,fetcher,()=>0));
  await controller.load("reviews");
  const command={action:"event",severity:"P1",reason:"incident"};
  await controller.write("events",command);await controller.write("events",command);
  expect(fetcher.mock.calls[1]?.[1].headers["Idempotency-Key"]).toBe(fetcher.mock.calls[2]?.[1].headers["Idempotency-Key"]);
  const mismatch=new GovernanceController(new GovernanceClient(wallet,vi.fn().mockResolvedValue(reply({...view,items:[{id:"private"}],permissions:{...view.permissions,walletAddress:`0x${"2".repeat(40)}`}})),()=>0));
  await mismatch.load("reviews");expect(mismatch.snapshot().items).toEqual([]);expect(mismatch.snapshot().error?.status).toBe(401);
});
it("approval needs explicit current reviewer permission, matching version and an independent owner",()=>{
  const other=`0x${"2".repeat(40)}`;
  const p={status:"pending",proposer_wallet:other,review_context:{from:"draft",to:"published",version:1,expectedVersion:1,ownerWallet:other}};
  expect(canReview(p,view.permissions,wallet)).toBe(false);
  expect(canReview(p,{...view.permissions,reviewer:true},wallet)).toBe(true);
  expect(canReview({...p,review_context:{...p.review_context,version:2}},{...view.permissions,reviewer:true},wallet)).toBe(false);
  expect(canReview({...p,review_context:{...p.review_context,ownerWallet:wallet}},{...view.permissions,reviewer:true},wallet)).toBe(false);
});
it("component exposes login and honest unverified state, and renders audit preview without self approval",()=>{
  const html=renderToStaticMarkup(<GovernancePanel walletAddress={null}/>);
  expect(html).toContain("Connect your wallet first");
  expect(html).not.toContain("sensitive");
  const proposal={id:"proposal-1",kind:"resume",status:"pending",proposer_wallet:wallet,review_context:{targetId:"task-1",from:"manual_review",to:"in_progress",version:2,expectedVersion:2,releaseId:null,restoredReleaseId:null}};
  expect(canReview(proposal,{...view.permissions,reviewer:true},wallet)).toBe(false);
  const preview=renderToStaticMarkup(<ReviewPreview proposal={proposal}/>);
  for(const text of ["task-1","manual_review","in_progress","2"]) expect(preview).toContain(text);
});
