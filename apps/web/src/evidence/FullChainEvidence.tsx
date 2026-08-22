import "./full-chain.css";
import { useLanguage } from "../i18n/LanguageProvider";

const chain = {
  en: [["Web Edge", "SSR / hydration / CSR fallback", "verified-production"], ["Wallet identity", "challenge-sign-verify + HttpOnly", "verified-local"], ["Transaction API", "server-derived unsigned intent", "verified-local"], ["Sepolia contracts", "escrow / settlement / staking / arbitration", "pending-external"], ["Chain authority", "exact receipt + event readback", "pending-external"], ["Reconciliation", "Blockscout + RPC", "pending-external"], ["Performance ingestion", "API Gateway + Lambda + HMAC", "pending-external"], ["Async delivery", "SNS + SQS / DLQ", "pending-external"], ["Compute + persistence", "ECS Fargate + PostgreSQL", "pending-external"], ["Matching", "Go matcher + pgvector", "verified-local"], ["Training", "deterministic grouped OOF/CV", "verified-local"], ["Model lifecycle", "safe JSON artifact + explicit activation", "verified-local"], ["Operations", "replay / ops / pause", "pending-external"], ["Delivery", "GitHub Actions + Cloudflare", "verified-production"]],
  zh: [["Web Edge", "SSR / hydration / CSR fallback", "verified-production"], ["钱包身份", "challenge-sign-verify + HttpOnly", "verified-local"], ["交易 API", "服务端生成 unsigned intent", "verified-local"], ["Sepolia 合约", "托管 / 结算 / 质押 / 仲裁", "pending-external"], ["链上权威", "精确回读 receipt + event", "pending-external"], ["对账", "Blockscout + RPC", "pending-external"], ["性能接入", "API Gateway + Lambda + HMAC", "pending-external"], ["异步投递", "SNS + SQS / DLQ", "pending-external"], ["计算与持久化", "ECS Fargate + PostgreSQL", "pending-external"], ["匹配", "Go matcher + pgvector", "verified-local"], ["训练", "确定性 grouped OOF/CV", "verified-local"], ["模型生命周期", "安全 JSON artifact + 显式激活", "verified-local"], ["运维", "replay / ops / pause", "pending-external"], ["交付", "GitHub Actions + Cloudflare", "verified-production"]],
} as const;

export function FullChainEvidence() {
  const { locale } = useLanguage();
  return (
    <section className="full-chain" aria-labelledby="full-chain-title">
      <div className="full-chain__heading">
        <div>
          <p className="full-chain__eyebrow">END-TO-END / PHASE 2</p>
          <h2 id="full-chain-title">{locale === "zh-CN" ? "一条交付链，四种证据状态" : "One delivery chain, four evidence states"}</h2>
        </div>
        <code>correlation: request_id</code>
      </div>

      <p className="full-chain__intro">
        {locale === "zh-CN" ? "Cloudflare V2 已凭新的部署标识符与公开 SSR 回读进入 verified-production；Sepolia 与 AWS 仍为 pending-external。" : "Cloudflare V2 reached verified-production through a fresh deployment identifier and public SSR readback; Sepolia and AWS remain pending-external."}
      </p>

      <figure className="full-chain__diagram">
        <img
          src={locale === "zh-CN" ? "/architecture/full-delivery-chain.zh-CN.svg" : "/architecture/full-delivery-chain.svg"}
          width="1600"
          height="900"
          style={{ aspectRatio: "1600 / 900" }}
          alt={locale === "zh-CN" ? "Agent Market V2 全交付链路及证据状态" : "Agent Market V2 full delivery chain and evidence states"}
          loading="lazy"
          decoding="async"
        />
        <figcaption>
          {locale === "zh-CN" ? "架构意图不是生产证明；每个外部 hop 独立验收。" : "Architecture intent is not production proof; every external hop is accepted independently."}
        </figcaption>
      </figure>

      <ol className="full-chain__steps">
        {chain[locale === "zh-CN" ? "zh" : "en"].map(([name, detail, status], index) => (
          <li key={`${name}-${index}`} data-chain-step={index + 1}>
            <span className="full-chain__index">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h3>{name}</h3>
              <p>{detail}</p>
            </div>
            <strong data-status={status}>{status}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}
