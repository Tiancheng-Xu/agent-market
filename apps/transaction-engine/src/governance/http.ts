import { getAuthOrigin, getAuthService } from "../auth/runtime";
import { AuthError, readSessionCookie } from "../auth/session";
import { resolveRequestId } from "../lib/request-context";
import { getGovernanceService } from "./runtime";
import { GovernanceError, parseCommand } from "./service";

const actions: Record<string,string[]> = {
  events:["event"],tickets:["open_ticket","resolve_ticket"],reviews:["review"],
  commands:["halt","resume","propose_release","propose_rollback"],
};
async function readBoundedBody(request:Request):Promise<string> {
  if(!request.body)return "";
  const reader=request.body.getReader();
  const decoder=new TextDecoder();
  const deadline=Date.now()+5000;
  let cancelled=false;
  const cancel=()=>{
    if(cancelled)return;
    cancelled=true;
    // Cancellation is best effort; an untrusted stream may never settle it.
    void reader.cancel().catch(()=>undefined);
  };
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>{reject(new GovernanceError("GOVERNANCE_BODY_TIMEOUT",408));cancel();},5000);
  });
  let bytes=0,text="";
  const consume=async()=>{
    while(true){
      const {done,value}=await reader.read();
      if(Date.now()>=deadline){cancel();throw new GovernanceError("GOVERNANCE_BODY_TIMEOUT",408);}
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>16*1024){
        cancel();
        throw new GovernanceError("GOVERNANCE_INPUT_TOO_LARGE",413);
      }
      text+=decoder.decode(value,{stream:true});
    }
    return text+decoder.decode();
  };
  try {return await Promise.race([consume(),timeout]);}
  finally {clearTimeout(timer);reader.releaseLock();}
}
export async function handleGovernance(request: Request,resource: string): Promise<Response> {
  const requestId=resolveRequestId(request.headers);
  const headers={"cache-control":"no-store","x-request-id":requestId};
  try {
    if (request.method==="POST" && request.headers.get("origin")!==getAuthOrigin().origin) throw new AuthError("AUTH_ORIGIN_MISMATCH",403);
    const token=readSessionCookie(request.headers);
    if (!token) throw new AuthError("AUTH_SESSION_INVALID");
    const auth=getAuthService(), session=await auth.authenticateSession(token);
    if (request.method==="GET") return Response.json({...await getGovernanceService().readView(session.walletAddress,resource),requestId},{headers});
    auth.requireRecentAuth(session);
    const text=await readBoundedBody(request);
    let body: unknown;
    try {body=JSON.parse(text);} catch {throw new GovernanceError("GOVERNANCE_INPUT_INVALID",400);}
    const command=parseCommand(body);
    if (!actions[resource]?.includes(String(command.action))) throw new GovernanceError("GOVERNANCE_INPUT_INVALID",400);
    const rechecked=await auth.authenticateSession(token);
    auth.requireRecentAuth(rechecked);
    if(rechecked.walletAddress.toLowerCase()!==session.walletAddress.toLowerCase()
      || rechecked.sessionId!==session.sessionId || rechecked.chainId!==session.chainId){
      throw new AuthError("AUTH_SESSION_CHANGED");
    }
    const result=await getGovernanceService().execute(rechecked.walletAddress,request.headers.get("idempotency-key")?.trim()??"",requestId,command);
    return Response.json({result,requestId},{headers});
  } catch (error) {
    const known=error instanceof AuthError || error instanceof GovernanceError;
    return Response.json({error:known ? error.code:"GOVERNANCE_UNAVAILABLE",requestId},{status:known ? error.status:503,headers});
  }
}
