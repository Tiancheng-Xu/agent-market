import { assertWalletSessionAuthenticated, walletSessionRevision } from "../lib/walletSession";
export type RecordData=Record<string,unknown>;
export type Resource="events"|"tickets"|"reviews"|"compensation"|"audit";
export type WriteResource="events"|"tickets"|"reviews"|"commands";
export interface Permissions {walletAddress:string;operator:boolean;reviewer:boolean;source:string}
export interface GovernanceView {items:RecordData[];permissions:Permissions;requestId:string}
export class GovernanceClientError extends Error {constructor(readonly code:string,readonly status:number,readonly requestId=""){super(code);}}
export const object=(v:unknown):RecordData=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as RecordData:{};
export class GovernanceClient {
  private readonly revision:number;
  constructor(readonly wallet:string,private readonly fetcher:typeof fetch=fetch,private readonly currentRevision=walletSessionRevision){this.revision=currentRevision();}
  private assertSession(){
    if(this.revision!==this.currentRevision())throw new GovernanceClientError("AUTH_WALLET_CHANGED",401);
    try{assertWalletSessionAuthenticated();}catch{throw new GovernanceClientError("AUTH_REAUTH_REQUIRED",401);}
  }
  private async request(path:string,init:RequestInit){
    this.assertSession();
    let response:Response;
    try{response=await this.fetcher(`/api/governance/${path}`,{...init,credentials:"include",cache:"no-store",signal:AbortSignal.timeout(15000)});}
    catch(error){this.assertSession();throw error;}
    this.assertSession();
    const body=object(await response.json().catch(()=>null));
    this.assertSession();
    if(!response.ok)throw new GovernanceClientError(typeof body.error==="string"?body.error:"GOVERNANCE_UNAVAILABLE",response.status,String(body.requestId??""));
    return body;
  }
  async read(resource:Resource):Promise<GovernanceView>{
    const body=await this.request(resource,{method:"GET"}),p=object(body.permissions);
    if(typeof p.walletAddress!=="string"||p.walletAddress.toLowerCase()!==this.wallet.toLowerCase())throw new GovernanceClientError("AUTH_WALLET_CHANGED",401);
    if(!Array.isArray(body.items)||body.items.some(x=>!x||typeof x!=="object"||Array.isArray(x))||typeof p.operator!=="boolean"||typeof p.reviewer!=="boolean"||p.source!=="agent_market.governance_roles")throw new GovernanceClientError("GOVERNANCE_RESPONSE_INVALID",502);
    return body as unknown as GovernanceView;
  }
  async write(resource:WriteResource,command:RecordData,key:string){
    const body=await this.request(resource,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key},body:JSON.stringify(command)});
    if(!body.result||typeof body.result!=="object")throw new GovernanceClientError("GOVERNANCE_RESPONSE_INVALID",502);
    return {result:object(body.result),requestId:String(body.requestId??"")};
  }
}
export interface GovernanceState {resource:Resource;items:RecordData[];permissions:Permissions|null;busy:boolean;error:GovernanceClientError|null;message:string;requestId:string}
export class GovernanceController {
  private state:GovernanceState={resource:"reviews",items:[],permissions:null,busy:false,error:null,message:"",requestId:""};
  private listeners=new Set<()=>void>();private epoch=0;private retry:{signature:string;key:string}|null=null;
  constructor(private readonly client:GovernanceClient){}
  snapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
  private set(change:Partial<GovernanceState>){this.state={...this.state,...change};this.listeners.forEach(fn=>fn());}
  clear(error:GovernanceClientError|null=null){this.epoch++;this.retry=null;this.set({items:[],permissions:null,busy:false,error,message:"",requestId:""});}
  private error(v:unknown){return v instanceof GovernanceClientError?v:new GovernanceClientError("GOVERNANCE_UNAVAILABLE",503);}
  private failed(error:GovernanceClientError){this.set({items:[],permissions:null,busy:false,error,message:"",requestId:error.requestId});}
  async load(resource:Resource=this.state.resource,keepError:GovernanceClientError|null=null,message=""){
    const epoch=++this.epoch;this.set({resource,items:[],busy:true,error:keepError,message});
    try{const view=await this.client.read(resource);if(epoch===this.epoch)this.set({items:view.items,permissions:view.permissions,busy:false,error:keepError,message,requestId:view.requestId});}
    catch(error){if(epoch===this.epoch)this.failed(this.error(error));}
  }
  async write(resource:WriteResource,command:RecordData){
    const epoch=++this.epoch,signature=JSON.stringify([resource,command]);
    if(this.retry?.signature!==signature)this.retry={signature,key:crypto.randomUUID()};
    this.set({busy:true,error:null,message:""});
    try{const response=await this.client.write(resource,command,this.retry.key);if(epoch!==this.epoch)return;this.retry=null;await this.load(this.state.resource,null,String(response.result.status));}
    catch(value){if(epoch!==this.epoch)return;const error=this.error(value);this.failed(error);if(error.status===409)await this.load(this.state.resource,error);}
  }
}
export function canReview(p:RecordData,permissions:Permissions|null,wallet:string){
  const c=object(p.review_context),payload=object(p.payload),same=(v:unknown)=>typeof v==="string"&&v.toLowerCase()===wallet.toLowerCase();
  return Boolean(permissions?.reviewer&&p.status==="pending"&&!same(p.proposer_wallet)&&!same(payload.owner_wallet)&&!same(c.ownerWallet)&&typeof c.from==="string"&&typeof c.to==="string"&&Number.isSafeInteger(c.version)&&c.version===c.expectedVersion);
}
export function errorText(e:GovernanceClientError,locale:"en"|"zh-CN"="zh-CN"){
  if(locale==="en"){
    if(e.status===401)return "Your session expired or the wallet changed. Sign in again. Previous results have been cleared.";
    if(e.status===403)return e.code==="AUTH_RECENT_REQUIRED"?"Recent authentication expired. Sign in again. Previous results have been cleared.":"Access is unavailable, revoked, or blocked by the independent-review rule. Previous results have been cleared. This interface cannot grant roles.";
    if(e.status===409)return e.code==="GOVERNANCE_MANUAL_REVIEW_REQUIRED"?"The order was stopped again (manual_review). An earlier recovery result cannot be reused. A fresh query was requested; check the current version.":"State, version or idempotency conflict. A fresh query was requested; inspect the latest records before retrying.";
    return "The governance service is unavailable or returned invalid data. No example results are shown. Try again later.";
  }
  if(e.status===401)return "登录已失效或钱包已切换。请重新进行钱包签名登录，旧结果已清空。";
  if(e.status===403)return e.code==="AUTH_RECENT_REQUIRED"?"近期认证已过期，请重新签名登录。旧结果已清空。":"当前账号无权限、权限已撤销或禁止自审。旧结果已清空；界面不能授予角色。";
  if(e.status===409)return e.code==="GOVERNANCE_MANUAL_REVIEW_REQUIRED"?"订单已再次急停（manual_review），旧恢复结果不可复用。已重新查询，请检查最新版本。":"状态、版本或幂等请求冲突。已重新查询，请检查最新记录后操作。";
  return "治理服务暂不可用或返回无效数据。未展示示例结果，请稍后重试。";
}
