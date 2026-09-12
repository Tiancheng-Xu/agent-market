import { useEffect,useMemo,useState,useSyncExternalStore,type FormEvent } from "react";
import { authenticateWalletSession } from "../lib/chainClient";
import { subscribeWalletSession } from "../lib/walletSession";
import { GovernanceClient,GovernanceClientError,GovernanceController,canReview,errorText,object,type RecordData,type Resource,type WriteResource } from "./client";
import "./governance.css";
import { useGovernanceCopy } from "./copy";
const resources:ReadonlyArray<readonly [Resource,string]>=[["reviews","双人复核"],["tickets","售后工单"],["events","运营事件"],["compensation","补偿建议"],["audit","审计记录"]];
const text=(v:unknown)=>v===null||v===undefined?"N/A":typeof v==="object"?JSON.stringify(v):String(v);
export function ReviewPreview({proposal}:{proposal:RecordData}){
  const {t}=useGovernanceCopy();
  const c=object(proposal.review_context);
  return <section className="gov-preview" aria-label={t("复核前审计信息")}><h3>{t("复核前核对")}</h3><dl>{[[t("提案"),proposal.id],[t("操作"),proposal.kind],[t("目标 target"),c.targetId??proposal.target_id],[t("当前状态 from"),c.from],[t("批准后状态 to"),c.to],[t("当前版本"),c.version],[t("提案预期版本"),c.expectedVersion],[t("批准后版本"),typeof c.expectedVersion==="number"?c.expectedVersion+1:null],[t("发布记录 release"),c.releaseId],[t("回滚来源 release"),c.restoredReleaseId],[t("发起钱包"),proposal.proposer_wallet],[t("提案原因"),proposal.reason]].map(([label,value])=><div key={String(label)}><dt>{String(label)}</dt><dd>{text(value)}</dd></div>)}</dl><p>{t("以上为本次查询的服务端状态；提交时仍会重新检查权限、版本和急停状态。")}</p></section>;
}
export function GovernancePanel({walletAddress}:{walletAddress:string|null}){
  const {t}=useGovernanceCopy();
  return <section className="governance-panel" aria-label={t("治理运营")}><header><span className="gov-kicker">GOVERNANCE / L4</span><h2>{t("治理运营")}</h2><p>{t("读取已认证 API。角色由数据库授权，页面不能提权；补偿只提供建议，不执行云操作或资金裁决。")}</p></header>{!walletAddress?<p role="status">{t("请先连接钱包，再使用已有登录会话查询治理数据。")}</p>:<ConnectedPanel key={walletAddress.toLowerCase()} walletAddress={walletAddress}/>}</section>;
}
function ConnectedPanel({walletAddress}:{walletAddress:string}){
  const {locale,t}=useGovernanceCopy();
  const [session,setSession]=useState(0);
  const controller=useMemo(()=>new GovernanceController(new GovernanceClient(walletAddress)),[walletAddress,session]);
  const s=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
  const [selected,setSelected]=useState("");const [reason,setReason]=useState("");const [confirmed,setConfirmed]=useState("");const [authBusy,setAuthBusy]=useState(false);const [authError,setAuthError]=useState("");
  useEffect(()=>{void controller.load("reviews");return ()=>controller.clear();},[controller]);
  useEffect(()=>subscribeWalletSession(()=>controller.clear(new GovernanceClientError("AUTH_REAUTH_REQUIRED",401))),[controller]);
  useEffect(()=>{if(!s.permissions){setSelected("");setReason("");setConfirmed("");}},[s.permissions]);
  const proposal=s.resource==="reviews"?s.items.find(p=>p.id===selected):undefined,c=object(proposal?.review_context),previewKey=`${selected}:${text(c.version)}`;
  const allowed=proposal&&canReview(proposal,s.permissions,walletAddress);
  async function login(){controller.clear();setAuthBusy(true);setAuthError("");try{await authenticateWalletSession(walletAddress);setSession(v=>v+1);}catch{setAuthError("AUTH_FAILED");}finally{setAuthBusy(false);}}
  return <><div className="gov-toolbar"><span className="gov-wallet">{walletAddress}</span><button type="button" disabled={s.busy||authBusy} onClick={()=>void login()}>{t("钱包签名登录 / 重新认证")}</button><button type="button" disabled={s.busy||authBusy} onClick={()=>void controller.load()}>{t("刷新")}</button></div>
    <p className="gov-permissions">{s.permissions?`${t("当前权限：运营")} ${s.permissions.operator?t("是"):t("否")} / ${t("复核")} ${s.permissions.reviewer?t("是"):t("否")}. ${t("来源")}: ${s.permissions.source}`:t("权限尚未确认，写操作不可用。")}</p>
    <nav className="gov-tabs" aria-label={t("治理数据分类")}>{resources.map(([r,label])=><button type="button" aria-pressed={s.resource===r} disabled={s.busy||authBusy} key={r} onClick={()=>{setSelected("");setConfirmed("");void controller.load(r);}}>{t(label)}</button>)}</nav>
    {authError&&<p role="alert">{t("钱包签名登录未完成。未发送交易，请核对账号和网络后重试。")}</p>}{s.error&&<div role="alert" className="gov-error"><strong>{errorText(s.error,locale)}</strong><small>{s.error.code} {s.error.requestId}</small></div>}{s.message&&<p role="status">{t("操作已记录")}: {s.message}. {t("已刷新服务端数据。")}</p>}{s.busy&&<p role="status">{t("正在查询或提交，请稍候…")}</p>}
    <div className="gov-layout"><section aria-label={t("服务端治理记录")}><h3>{t(resources.find(([r])=>r===s.resource)?.[1]??"")}</h3>{!s.busy&&!s.error&&s.permissions&&!s.items.length&&<p>{t("服务端当前返回 0 条记录。")}</p>}
      {s.items.map((item,i)=><article className="gov-record" key={String(item.id??item.targetId??i)}><div><strong>{text(item.kind??item.severity??item.status??item.action)}</strong><span>{text(item.id??item.targetId)}</span></div>{s.resource==="reviews"?<><p>{text(item.status)} · {t("发起人")} {text(item.proposer_wallet)}</p><p>{text(item.reason)}</p><button type="button" disabled={s.busy} onClick={()=>{setSelected(String(item.id));setConfirmed("");}}>{t("查看复核信息")}</button></>:<pre>{JSON.stringify(item,null,2)}</pre>}</article>)}{s.requestId&&<small>{t("查询 requestId")}: {s.requestId} · {t("最多 100 条，非全历史")}</small>}</section><aside>
      {proposal&&<><ReviewPreview proposal={proposal}/><label>{t("复核理由")}<textarea value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)}/></label><label className="gov-confirm"><input type="checkbox" checked={confirmed===previewKey} onChange={e=>setConfirmed(e.target.checked?previewKey:"")}/>{t("已核对目标、状态、版本及发布记录")}</label>{!allowed&&<p>{t("不可复核：需要独立 reviewer 权限、待审提案及一致版本，发起人和 Agent 所有人不能自批。")}</p>}<div className="gov-toolbar">{(["approve","reject"] as const).map(decision=><button type="button" key={decision} disabled={s.busy||!allowed||!reason.trim()||confirmed!==previewKey} onClick={()=>void controller.write("reviews",{action:"review",targetId:proposal.id,decision,reason})}>{decision==="approve"?t("批准并记录审计"):t("驳回并记录审计")}</button>)}</div></>}
      <CommandForm disabled={s.busy||authBusy||!s.permissions} clear={!s.permissions} operator={s.permissions?.operator??false} onSubmit={(r,b)=>controller.write(r,b)}/></aside></div></>;
}
function CommandForm({disabled,clear,operator,onSubmit}:{disabled:boolean;clear:boolean;operator:boolean;onSubmit:(r:WriteResource,b:RecordData)=>Promise<void>}){
  const {t}=useGovernanceCopy();
  const [action,setAction]=useState("open_ticket"),[targetId,setTargetId]=useState(""),[version,setVersion]=useState(""),[releaseId,setReleaseId]=useState(""),[reason,setReason]=useState(""),[severity,setSeverity]=useState("P1"),[error,setError]=useState("");
  const operational=!["open_ticket","propose_release"].includes(action),needsVersion=!["open_ticket","event"].includes(action);
  useEffect(()=>{if(clear){setReason("");setTargetId("");setReleaseId("");setVersion("");}},[clear]);
  function submit(e:FormEvent){e.preventDefault();setError("");if(disabled||(operational&&!operator))return;if(!reason.trim()||(needsVersion&&(!Number.isSafeInteger(Number(version))||Number(version)<1))){setError("INVALID");return;}const b:RecordData={action,reason};if(action==="event")b.severity=severity;else b.targetId=targetId;if(needsVersion)b.expectedVersion=Number(version);if(action==="propose_rollback")b.releaseId=releaseId;void onSubmit(action==="event"?"events":action.includes("ticket")?"tickets":"commands",b);}
  return <form className="gov-command" onSubmit={submit}><h3>{t("提交治理请求")}</h3><p>{t("工单仅限订单双方；发布提案仅限 Agent 所有人或运营。服务端会再次鉴权。")}</p><fieldset disabled={disabled}><label>{t("操作")}<select value={action} onChange={e=>setAction(e.target.value)}>{[["open_ticket",t("创建售后工单")],["propose_release",t("提交发布复核")],["event",t("记录运营事件")],["halt",t("立即急停订单")],["resume",t("申请恢复订单")],["propose_rollback",t("申请回滚发布")],["resolve_ticket",t("申请工单结案")]].map(([value,label])=><option key={value} value={value} disabled={!["open_ticket","propose_release"].includes(value!)&&!operator}>{label}</option>)}</select></label>
    {action!=="event"&&<label>{t("目标 UUID")}<input required value={targetId} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" onChange={e=>setTargetId(e.target.value)}/></label>}{needsVersion&&<label>{t("当前版本")}<input type="number" min="1" step="1" required value={version} onChange={e=>setVersion(e.target.value)}/></label>}{action==="propose_rollback"&&<label>{t("恢复至已批准 release UUID")}<input required value={releaseId} onChange={e=>setReleaseId(e.target.value)}/></label>}{action==="event"&&<label>{t("事件等级")}<select value={severity} onChange={e=>setSeverity(e.target.value)}>{["P0","P1","P2","P3"].map(v=><option key={v}>{v}</option>)}</select></label>}<label>{t("理由")}<textarea required maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label><button type="submit" disabled={disabled||(operational&&!operator)}>{t("提交")}{action==="halt"?t("急停"):t("请求")}</button></fieldset>{error&&<p role="alert">{t("请填写理由与有效的当前版本。")}</p>}</form>;
}
