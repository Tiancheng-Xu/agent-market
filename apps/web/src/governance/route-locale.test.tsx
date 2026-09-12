import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach,expect,it,vi } from "vitest";
import App from "../App";
import { ServerApp } from "../ssr/ServerApp";
import { GovernancePanel,ReviewPreview } from "./GovernancePanel";
import { GovernanceClientError,errorText } from "./client";
const state=vi.hoisted(()=>({locale:"en" as "en"|"zh-CN",address:`0x${"a".repeat(40)}`,walletCalls:vi.fn()}));
vi.mock("../hooks/useWallet",()=>({useWallet:()=>{state.walletCalls();return {wallet:{address:state.address,chainId:"0xaa36a7",status:"connected",error:null,message:null},connect:vi.fn(),switchToSepolia:vi.fn(),isSepolia:true};}}));
vi.mock("../components/Shell",()=>({Shell:({children}:{children:React.ReactNode})=><>{children}</>}));
vi.mock("../i18n/LanguageProvider",async original=>({...await original<typeof import("../i18n/LanguageProvider")>(),useLanguage:()=>({locale:state.locale,setLocale:vi.fn(),t:(v:string)=>v})}));
beforeEach(()=>{state.locale="en";state.walletCalls.mockClear();});
it("actual /ops App route passes the existing wallet to the real governance panel",()=>{
  const html=renderToStaticMarkup(<MemoryRouter initialEntries={["/ops"]}><App/></MemoryRouter>);
  expect(html).toContain(state.address);
  expect(html).toContain("Independent review");
  expect(html).toContain("Open a support ticket");
  expect(html).not.toContain("Connect your wallet first");
  expect(state.walletCalls).toHaveBeenCalledTimes(1);
});
it("ServerApp /ops renders a disconnected governance surface without creating a wallet",()=>{
  const html=renderToStaticMarkup(<ServerApp pathname="/ops/"/>);
  expect(html).toContain("Connect your wallet first");expect(html).not.toContain(state.address);
  expect(state.walletCalls).not.toHaveBeenCalled();
});
it.each(["en","zh-CN"] as const)("all panel labels and form copy follow useLanguage: %s",locale=>{
  state.locale=locale;
  const html=renderToStaticMarkup(<GovernancePanel walletAddress={state.address}/>);
  for(const label of locale==="en"?["Independent review","Support tickets","Operational events","Audit log","Submit a governance request","Sign in / Reauthenticate","Permissions have not been confirmed"]:["双人复核","售后工单","运营事件","审计记录","提交治理请求","钱包签名登录","权限尚未确认"])expect(html).toContain(label);
  if(locale==="en")expect(html).not.toMatch(/[\u3400-\u9fff]/u);
  const preview=renderToStaticMarkup(<ReviewPreview proposal={{id:"proposal",reason:"verified evidence",review_context:{targetId:"task",from:"manual_review",to:"in_progress",version:2,expectedVersion:2}}}/>);
  expect(preview).toContain(locale==="en"?"Check before reviewing":"复核前核对");
  expect(preview).toContain("manual_review");
});
it("401/403/409 and unavailable messages have explicit English and Chinese forms",()=>{
  for(const [code,status] of [["AUTH_SESSION_INVALID",401],["GOVERNANCE_FORBIDDEN",403],["AUTH_RECENT_REQUIRED",403],["GOVERNANCE_MANUAL_REVIEW_REQUIRED",409],["GOVERNANCE_VERSION_CONFLICT",409],["GOVERNANCE_UNAVAILABLE",503]] as const){
    const e=new GovernanceClientError(code,status);
    expect(errorText(e,"en")).not.toMatch(/[\u3400-\u9fff]/u);
    expect(errorText(e,"zh-CN")).toMatch(/[\u3400-\u9fff]/u);
  }
});
