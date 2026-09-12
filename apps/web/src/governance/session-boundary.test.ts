import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { invalidateWalletSession,withWalletSession } from "../lib/walletSession";
import { GovernanceClient,GovernanceController } from "./client";
const wallet=`0x${"1".repeat(40)}`;
const response=()=>new Response(JSON.stringify({items:[{id:"private"}],permissions:{walletAddress:wallet,operator:true,reviewer:true,source:"agent_market.governance_roles"},requestId:"request"}));
beforeEach(async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("{}")));await withWalletSession(async()=>{});});
afterEach(()=>vi.unstubAllGlobals());
it("local session veto blocks reconstructed same-wallet client reads and writes after failed logout",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("offline logout")));
  await expect(invalidateWalletSession()).rejects.toThrow("AUTH_LOGOUT_UNAVAILABLE");
  const business=vi.fn().mockImplementation(response);
  const client=new GovernanceClient(wallet,business);
  const controller=new GovernanceController(client);
  await controller.load("reviews");
  expect(controller.snapshot().error?.status).toBe(401);
  expect(controller.snapshot().items).toEqual([]);expect(controller.snapshot().permissions).toBeNull();
  await expect(client.write("events",{action:"event",reason:"test",severity:"P1"},"same-wallet-key")).rejects.toMatchObject({status:401});
  expect(business).not.toHaveBeenCalled();
});
it("local session veto discards an in-flight server success after authentication invalidates",async()=>{
  let finish:(response:Response)=>void=()=>{};
  const delayed=new Promise<Response>(resolve=>{finish=resolve;});
  const business=vi.fn().mockResolvedValueOnce(response()).mockReturnValueOnce(delayed);
  // Freeze the revision reader to specifically exercise the independent local-auth veto.
  const client=new GovernanceClient(wallet,business,()=>0),controller=new GovernanceController(client);
  await controller.load("reviews");expect(controller.snapshot().items).toHaveLength(1);
  const pending=controller.load("audit");
  await invalidateWalletSession();finish(response());await pending;
  expect(controller.snapshot().error?.status).toBe(401);
  expect(controller.snapshot().items).toEqual([]);expect(controller.snapshot().permissions).toBeNull();
});
