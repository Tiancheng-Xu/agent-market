import { useLanguage } from "../i18n/LanguageProvider";
export const english:Record<string,string>={
"双人复核":"Independent review","售后工单":"Support tickets","运营事件":"Operational events","补偿建议":"Compensation suggestions","审计记录":"Audit log",
"复核前审计信息":"Audit details before review","复核前核对":"Check before reviewing","提案":"Proposal","操作":"Action","目标 target":"Target","当前状态 from":"Current state (from)","批准后状态 to":"State after approval (to)","当前版本":"Current version","提案预期版本":"Expected version","批准后版本":"Version after approval","发布记录 release":"Release record","回滚来源 release":"Release to restore","发起钱包":"Proposer wallet","提案原因":"Proposal reason","未提供":"Not provided",
"以上为本次查询的服务端状态；提交时仍会重新检查权限、版本和急停状态。":"These values reflect the latest query. The server rechecks permissions, versions and emergency stops when submitted.",
"治理运营":"Governance operations","读取已认证 API。角色由数据库授权，页面不能提权；补偿只提供建议，不执行云操作或资金裁决。":"Reads authenticated APIs. Roles come from database grants; this page cannot grant access. Compensation is advisory and does not execute cloud operations or financial rulings.",
"请先连接钱包，再使用已有登录会话查询治理数据。":"Connect your wallet first, then use your existing session to query governance data.",
"钱包签名登录 / 重新认证":"Sign in / Reauthenticate","刷新":"Refresh","是":"yes","否":"no","当前权限：运营":"Current permissions: operator","复核":"reviewer","来源":"Source",
"权限尚未确认，写操作不可用。":"Permissions have not been confirmed. Write actions are unavailable.","治理数据分类":"Governance categories",
"钱包签名登录未完成。未发送交易，请核对账号和网络后重试。":"Wallet sign-in did not complete. No transaction was sent. Check your account and network before retrying.",
"正在查询或提交，请稍候…":"Querying or submitting. Please wait...","服务端治理记录":"Server governance records","服务端当前返回 0 条记录。":"The server returned no records.","发起人":"Proposer","查看复核信息":"Inspect review details","查询 requestId":"Query request ID","最多 100 条，非全历史":"Up to 100 records; not the complete history",
"复核理由":"Review reason","已核对目标、状态、版本及发布记录":"I checked the target, state, version and release records",
"不可复核：需要独立 reviewer 权限、待审提案及一致版本，发起人和 Agent 所有人不能自批。":"Review is unavailable: an independent reviewer, a pending proposal and matching versions are required. Proposers and agent owners cannot approve their own changes.",
"批准并记录审计":"Approve and audit","驳回并记录审计":"Reject and audit","提交治理请求":"Submit a governance request",
"工单仅限订单双方；发布提案仅限 Agent 所有人或运营。服务端会再次鉴权。":"Tickets are limited to order participants. Release proposals require the agent owner or an operator. The server rechecks authorization.",
"创建售后工单":"Open a support ticket","提交发布复核":"Propose a release","记录运营事件":"Record an incident","立即急停订单":"Stop an order immediately","申请恢复订单":"Request order recovery","申请回滚发布":"Request release rollback","申请工单结案":"Request ticket resolution",
"目标 UUID":"Target UUID","恢复至已批准 release UUID":"Approved release UUID to restore","事件等级":"Severity","理由":"Reason","提交":"Submit ","急停":"emergency stop","请求":"request",
"请填写理由与有效的当前版本。":"Enter a reason and a valid current version.","操作已记录":"Action recorded","已刷新服务端数据。":"Server data refreshed."
};
export function useGovernanceCopy(){const {locale}=useLanguage();return {locale,t:(source:string)=>locale==="zh-CN"?source:english[source]??source};}
