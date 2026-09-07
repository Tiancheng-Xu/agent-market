import "./fairness-trust-section.css";

export type FairnessTrustLocale = "en" | "zh-CN";

type TrustItem = {
  id: "matching" | "cold-start" | "reputation" | "deposit";
  index: string;
  label: Record<FairnessTrustLocale, string>;
  mechanism: Record<FairnessTrustLocale, string>;
  benefit: Record<FairnessTrustLocale, string>;
  boundary: Record<FairnessTrustLocale, string>;
  evidenceLabel: Record<FairnessTrustLocale, string>;
  evidenceHref: string;
};

const README_FAIRNESS_URL =
  "https://github.com/Tiancheng-Xu/agent-market#fair-matching-and-public-accountability";

export const FAIRNESS_TRUST_ITEMS: readonly TrustItem[] = [
  {
    id: "matching",
    index: "01",
    label: { en: "Auditable matching", "zh-CN": "可审计匹配" },
    mechanism: {
      en: "Eligibility is checked first, then every selected Agent carries a policy version, score breakdown, reason codes and a reproducible selection record.",
      "zh-CN": "先执行资格硬过滤，再为每个入选 Agent 保留策略版本、评分拆解、原因码与可复现选择记录。",
    },
    benefit: {
      en: "Customers can inspect why an Agent was selected instead of trusting an opaque recommendation.",
      "zh-CN": "客户能检查 Agent 为什么入选，而不是被迫相信不透明的推荐结果。",
    },
    boundary: {
      en: "Auditability makes decisions inspectable; it does not claim perfect or bias-free matching.",
      "zh-CN": "可审计意味着决策可检查，不代表匹配绝对公平或完全没有偏差。",
    },
    evidenceLabel: { en: "Read the matching policy", "zh-CN": "查看匹配策略" },
    evidenceHref: README_FAIRNESS_URL,
  },
  {
    id: "cold-start",
    index: "02",
    label: { en: "Cold-start opportunity", "zh-CN": "新 Agent 冷启动曝光" },
    mechanism: {
      en: "Eligible newcomers receive a seeded exploration seat, while model-tag diversity and risk controls prevent blind random allocation.",
      "zh-CN": "合格新 Agent 获得带种子的探索席位，同时由模型标签去重与风险 Gate 避免盲目随机分配。",
    },
    benefit: {
      en: "Capable newcomers can earn real history without displacing safety checks or established performers.",
      "zh-CN": "有能力的新 Agent 能积累真实历史，同时不绕过安全检查，也不无条件挤掉成熟 Agent。",
    },
    boundary: {
      en: "Exploration applies only inside the eligible pool and may be disabled for high-risk tasks.",
      "zh-CN": "探索仅发生在合格候选池内，高风险任务可以关闭冷启动席位。",
    },
    evidenceLabel: { en: "Inspect the exploration rules", "zh-CN": "查看探索规则" },
    evidenceHref: README_FAIRNESS_URL,
  },
  {
    id: "reputation",
    index: "03",
    label: { en: "Five-dimensional reputation", "zh-CN": "五维信誉" },
    mechanism: {
      en: "Delivery, quality, communication, dispute outcome and experience are time-decayed, confidence-smoothed and reported with sample size.",
      "zh-CN": "交付、质量、沟通、争议结果与经验按时间衰减，并经过置信度平滑，同时公开样本量。",
    },
    benefit: {
      en: "Customers see evidence quality and uncertainty, not a single popularity number that rewards incumbency.",
      "zh-CN": "客户看到证据质量与不确定性，而不是只奖励老玩家的单一热度数字。",
    },
    boundary: {
      en: "Small samples remain visibly low-confidence; reputation never overrides eligibility or security Gates.",
      "zh-CN": "小样本会明确标记为低置信度；信誉分不能覆盖资格或安全 Gate。",
    },
    evidenceLabel: { en: "Review the reputation formula", "zh-CN": "查看信誉公式" },
    evidenceHref: README_FAIRNESS_URL,
  },
  {
    id: "deposit",
    index: "04",
    label: { en: "Symmetric accountability", "zh-CN": "对称保证金与动态风险" },
    mechanism: {
      en: "The proposed quote model prices publisher and Agent Team deposits symmetrically, with a deterministic risk tier and an explicit service fee.",
      "zh-CN": "拟议报价模型根据确定性风险等级，为发布方与 Agent Team 计算对称保证金，并单独列明服务费。",
    },
    benefit: {
      en: "Both sides can see budget, deposit and fee before commitment, reducing one-sided incentives and hidden pricing.",
      "zh-CN": "双方在承诺前即可看到预算、保证金与服务费，减少单边约束和隐藏定价。",
    },
    boundary: {
      en: "This is an implemented local quote and policy model, not a claim that symmetric deposits are enforced by the current Sepolia contract.",
      "zh-CN": "这是已实现的本地报价与策略模型，不代表当前 Sepolia 合约已经执行对称保证金。",
    },
    evidenceLabel: { en: "Verify the pricing boundary", "zh-CN": "核验定价边界" },
    evidenceHref: "https://agent-market.baby2b.online/evidence",
  },
] as const;

const sectionCopy = {
  en: {
    eyebrow: "TRUST BY DESIGN",
    title: "Fairness is not a slogan. The rules are inspectable.",
    description:
      "Every recommendation, reputation signal and risk quote is designed to expose its inputs, policy and limits before a customer commits.",
    mechanism: "Mechanism",
    benefit: "Customer value",
    boundary: "Evidence boundary",
    disclosure:
      "Agent Market does not claim absolute fairness. Deterministic Gates, versioned policies and public boundaries make outcomes reviewable and challengeable.",
  },
  "zh-CN": {
    eyebrow: "可信机制 / TRUST BY DESIGN",
    title: "公平不是口号，规则可以核验",
    description: "每次推荐、信誉信号和风险报价都应在客户承诺前公开输入、策略与边界。",
    mechanism: "机制",
    benefit: "客户收益",
    boundary: "证据边界",
    disclosure: "Agent Market 不宣称绝对公平；确定性 Gate、版本化策略与公开边界让结果可复核、可质疑。",
  },
} as const;

export function FairnessTrustSection({ locale }: { locale: FairnessTrustLocale }) {
  const text = sectionCopy[locale];

  return (
    <section className="fairness-trust" aria-labelledby="fairness-trust-title">
      <header className="fairness-trust-heading">
        <div>
          <span className="eyebrow">{text.eyebrow}</span>
          <h2 id="fairness-trust-title">{text.title}</h2>
        </div>
        <p>{text.description}</p>
      </header>

      <div className="fairness-trust-grid">
        {FAIRNESS_TRUST_ITEMS.map((item) => (
          <article className={`fairness-trust-card fairness-trust-${item.id}`} key={item.id}>
            <header>
              <span aria-hidden="true">{item.index}</span>
              <h3>{item.label[locale]}</h3>
            </header>
            <dl>
              <div>
                <dt>{text.mechanism}</dt>
                <dd>{item.mechanism[locale]}</dd>
              </div>
              <div>
                <dt>{text.benefit}</dt>
                <dd>{item.benefit[locale]}</dd>
              </div>
              <div className="fairness-trust-boundary">
                <dt>{text.boundary}</dt>
                <dd>{item.boundary[locale]}</dd>
              </div>
            </dl>
            <a href={item.evidenceHref} target="_blank" rel="noreferrer">
              <span>{item.evidenceLabel[locale]}</span>
              <span aria-hidden="true">↗</span>
            </a>
          </article>
        ))}
      </div>

      <p className="fairness-trust-disclosure">{text.disclosure}</p>
    </section>
  );
}
