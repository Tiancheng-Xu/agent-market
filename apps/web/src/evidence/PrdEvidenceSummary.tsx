import { Badge, Panel } from "../components/Ui";

type Copy = { en: string; zh: string };
type Language = keyof Copy;

const source = {
  version: "as-built PRD v1",
  reviewed: "2026-10-12",
  sha256: "13281bf657f2b4aa8965eb5040bc024ad4eaf150e2f8484ede0239662cdcd73d",
};

const mechanisms: Array<{ title: Copy; detail: Copy }> = [
  {
    title: { en: "Qualified matching and reputation", zh: "合格匹配与信誉" },
    detail: {
      en: "Hard eligibility filters precede ranking and reproducible exploration. Confidence-aware reputation limits small-sample overstatement; these rules do not establish statistical fairness in production.",
      zh: "先做资格硬过滤，再排序和可复现探索。信誉考虑样本置信度，避免少量评价被夸大；这些规则不等于已证明生产中的统计公平。",
    },
  },
  {
    title: { en: "Confirmed workflow and recovery", zh: "确认后的工作流与恢复" },
    detail: {
      en: "Queen proposes a versioned task graph; confirmation, independent Judge, high-risk review and bounded repair remain separate responsibilities. Checkpoints retain progress; recovery rechecks authorization and external operation receipts.",
      zh: "Queen 提出版本化任务图；确认、独立 Judge、高风险审查和有上限的修复各有责任。Checkpoint 保存进度；恢复仍重新检查权限和外部操作回执。",
    },
  },
  {
    title: { en: "Money and settlement authority", zh: "资金与结算权威" },
    detail: {
      en: "Principal, symmetric bonds and platform fees are distinct ledger concepts. Wallet signatures, submission, matching receipt/events and settlement are distinct states. The historical V3 contract uses a fixed platform arbiter; AI review is not payment authority.",
      zh: "本金、对称保证金与平台费分别记账。钱包签名、提交、匹配回执与事件、结算分别建状态。历史 V3 合约使用固定平台仲裁者；AI 审查不具有付款权。",
    },
  },
  {
    title: { en: "Enterprise approval simulation", zh: "企业审批模拟" },
    detail: {
      en: "The local v1 uses synthetic identities, synthetic documents and in-memory records. Document-version/member/action grants, independent review and current-permission checks constrain idempotent mock writes. Character-span extraction is not PDF/OCR, production authentication or a real business connector.",
      zh: "本地 v1 使用合成身份、合成文档和内存记录。文档版本、成员、动作授权，独立审核与当前权限检查约束幂等模拟写入。字符片段提取不是 PDF/OCR、生产认证或真实业务 Connector。",
    },
  },
  {
    title: { en: "Model observation without business authority", zh: "模型观测与业务权威分离" },
    detail: {
      en: "System-One defaults to off/shadow and returns the deterministic baseline. Jev/Laya observations cannot authorize actions or money. Timeout does not release capacity until underlying work ends; missing usage remains unknown rather than zero.",
      zh: "System-One 默认 off/shadow，返回确定性基线。Jev/Laya 观测不能授权操作或资金。超时后直到实际工作结束才释放容量；用量缺失保留为未知，不能记成零。",
    },
  },
  {
    title: { en: "Interface and evidence boundaries", zh: "界面与证据边界" },
    detail: {
      en: "Edge SSR and bounded hydration fallback keep the interface readable; Cocos consumes sanitized status and desk-selection messages. A visible success, completed graph or recording cannot replace database, chain or cloud readback.",
      zh: "Edge SSR 与有界水合降级保持界面可读；Cocos 只消费脱敏状态和选桌消息。页面成功、任务图完成或录屏不能替代数据库、链上或云端读回。",
    },
  },
];

export function PrdEvidenceSummary({ language = "en" }: { language?: Language }) {
  const copy = (value: Copy) => value[language];
  return (
    <section id="prd-design" className="section-block" aria-labelledby="prd-design-title" data-prd-summary="agent-market">
      <div className="section-heading">
        <span className="eyebrow">PRD / DESIGN &amp; EVIDENCE SCOPE</span>
        <h2 id="prd-design-title">{copy({ en: "Agent Market: product, mechanisms and delivery scope", zh: "Agent Market：产品、机制与交付范围" })}</h2>
        <p>{copy({
          en: "A verifiable agent collaboration market: confirm task plans and qualified candidates, execute within authority, review quality independently, resolve disputes and settle against evidence. Customer adoption, revenue and production improvements require separate evidence.",
          zh: "可验证的智能体协作市场：确认任务计划与合格候选，在授权内执行，独立检查质量，处理争议并按证据结算。真实客户、收入和生产效果改善仍需各自的证据。",
        })}</p>
      </div>
      <div className="evidence-gallery">
        {mechanisms.map((mechanism) => <Panel key={mechanism.title.en} className="evidence-shot"><h3>{copy(mechanism.title)}</h3><p>{copy(mechanism.detail)}</p></Panel>)}
      </div>
      <div className="requirements-list">
        <div data-prd-scope="historical-delivery"><Panel>
          <Badge tone="indigo">{copy({ en: "Historical delivery / scoped proof", zh: "历史交付 / 范围限定的证据" })}</Badge>
          <h3>{copy({ en: "Preserved historical records", zh: "保留既有历史台账" })}</h3>
          <p>{copy({
            en: "Cloudflare UI delivery and recording, one controlled AWS V2 performance sample followed by pause, and Sepolia V3 receipt/event closure each retain their own version and scope. The single test EOA does not prove multi-wallet isolation, and historical pause is not a fresh cloud inventory or continuous service guarantee.",
            zh: "Cloudflare UI 发布与录屏、AWS V2 一条受控性能样本后暂停、Sepolia V3 回执与事件闭环各保留自己的版本和范围。单测试 EOA 不证明多钱包隔离；历史暂停不是本轮云资源库存或持续服务保证。",
          })}</p>
          <p><a className="text-link" href="/evidence/2026-09-13-external-chrome-production-walkthrough.json">{copy({ en: "Production UI recording ledger", zh: "生产 UI 录屏台账" })}</a>{" · "}<a className="text-link" href="/evidence/2026-08-27-aws-v2-performance-closure.json">{copy({ en: "AWS V2 controlled sample", zh: "AWS V2 受控样本" })}</a>{" · "}<a className="text-link" href="/evidence/2026-08-28-sepolia-v3-interaction-closure.json">{copy({ en: "Sepolia V3 interaction closure", zh: "Sepolia V3 交互闭环" })}</a></p>
        </Panel></div>
        <div data-prd-scope="local-unpublished"><Panel>
          <Badge tone="amber">{copy({ en: "Local enhancement / unpublished", zh: "本地增强 / 未发布" })}</Badge>
          <h3>{copy({ en: "Local acceptance has a limited scope", zh: "本地验收有明确范围" })}</h3>
          <p>{copy({
            en: "The PRD records limited enterprise approval v1 acceptance, offline Laya smoke, and segmented Queen, HTTP, process-close and token-counter reviews. Enterprise v1 and the current Jev/Laya/System-One enhancements remain unmerged and undeployed. These records do not establish complete runtime cleanup, representative model quality or full failure/timeout costs.",
            zh: "PRD 记录了有限的企业审批 v1 验收、离线 Laya Smoke，以及 Queen、HTTP、进程关闭和 token 计数的分段复审。企业 v1 与当前 Jev/Laya/System-One 增强仍未合并、未部署。这些记录不证明完整 Runtime 收尾、代表性模型质量或完整失败与超时成本。",
          })}</p>
        </Panel></div>
        <div data-prd-scope="design-target"><Panel>
          <Badge tone="neutral">{copy({ en: "Design target / not delivered", zh: "设计目标 / 尚未交付" })}</Badge>
          <h3>{copy({ en: "Proposed next-stage contracts", zh: "下一阶段建议合同" })}</h3>
          <p>{copy({
            en: "Server-derived identity and document-scoped authorization; a whitelisted parser adapter with verifiable source mapping; approvals bound to content, tool, policy and authorization versions; durable operation keys and Outbox with reconciliation for unknown connector results; bounded cancellation/cleanup and representative baseline-versus-candidate evaluation. Private label-probability storage and production integration remain separate work.",
            zh: "服务端解析身份与逐资料授权；带可验证来源映射的白名单解析 Adapter；绑定内容、工具、政策与授权版本的批准；持久操作键、Outbox 与 Connector 结果未知时的对账；有界取消与收尾、代表性基线和候选评测。私有标签概率存储和生产集成仍属独立后续工作。",
          })}</p>
        </Panel></div>
      </div>
      <p>{copy({ en: "Source snapshot", zh: "来源快照" })}: {source.version} · {copy({ en: "reviewed", zh: "核对日期" })} {source.reviewed}<br />SHA-256: <span style={{ overflowWrap: "anywhere" }}>{source.sha256}</span></p>
      <p>{copy({
        en: "This public PRD summary is not new test, model, chain, cloud, or production evidence. The digest identifies the document bytes; it is not identity authentication, a digital signature or proof of implementation. Private interview answers and local source paths are not published.",
        zh: "本次公开 PRD 摘要不是新增测试、模型、链上、云端或生产验收。摘要哈希标识文档字节，不是身份认证、数字签名或实现证明。私有面试问答与本机来源路径不公开。",
      })}</p>
    </section>
  );
}
