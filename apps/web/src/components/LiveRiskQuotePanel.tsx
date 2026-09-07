import { useMutation } from "@tanstack/react-query";
import { useLanguage } from "../i18n/LanguageProvider";
import { confirmCurrentRiskQuote, loadCurrentRiskQuote, refreshCurrentRiskQuote } from "../lib/riskQuoteFlow";
import type { QuoteConfirmationIntent } from "../riskPricingPresentation";
import { Panel } from "./Ui";

export function LiveRiskQuotePanel({ taskId, walletAddress, onFundingReady }: {
  taskId: string;
  walletAddress: string | null;
  onFundingReady: (context: QuoteConfirmationIntent | null) => void;
}) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const quote = useMutation({
    mutationFn: () => loadCurrentRiskQuote(taskId),
    onMutate: () => { onFundingReady(null); confirmation.reset(); refresh.reset(); },
  });
  const confirmation = useMutation({
    mutationFn: () => {
      if (!quote.data) throw new Error("RISK_QUOTE_NOT_LOADED");
      return confirmCurrentRiskQuote(taskId, quote.data);
    },
    onMutate: () => { onFundingReady(null); refresh.reset(); },
    onSuccess: (result) => onFundingReady(result.fundingContext),
  });
  const refresh = useMutation({
    mutationFn: () => {
      if (!quote.data) throw new Error("RISK_QUOTE_NOT_LOADED");
      return refreshCurrentRiskQuote(taskId, quote.data);
    },
    onMutate: () => { onFundingReady(null); confirmation.reset(); },
    onSuccess: (result) => onFundingReady(result.fundingContext),
  });
  const busy = quote.isPending || confirmation.isPending || refresh.isPending;
  const result = refresh.data ?? confirmation.data;
  const current = quote.data?.quote;
  const expired = current ? Date.parse(current.expiresAt) <= Date.now() : false;
  const amount = (value: string) => `${new Intl.NumberFormat(locale).format(BigInt(value))} atomic`;
  return (
    <Panel className="risk-quote-panel">
      <h2>{zh ? "任务风险报价" : "Task risk quote"}</h2>
      <p>{zh ? "按当前任务和分工读取服务端报价。任务变化后需要重新报价并确认。" : "Read the server quote for the current task and assignments. Task changes require a new quote and confirmation."}</p>
      <button className="button button-primary" type="button" disabled={!walletAddress || busy} onClick={() => quote.mutate()}>
        {zh ? "获取当前报价" : "Get current quote"}
      </button>
      {!walletAddress ? <p>{zh ? "请连接参与方钱包并完成登录。" : "Connect and authenticate a participant wallet."}</p> : null}
      {current ? (
        <>
          <p>{current.phase === "final" ? (zh ? "最终报价" : "Final quote") : (zh ? "初步报价" : "Preliminary quote")} · {current.riskTier} · {current.riskScore}/100</p>
          <dl>
            <dt>{zh ? "任务预算" : "Task budget"}</dt><dd>{amount(current.P)}</dd>
            <dt>{zh ? "单方保证金" : "Deposit per side"}</dt><dd>{amount(current.A)}</dd>
            <dt>{zh ? "平台服务费" : "Platform fee"}</dt><dd>{amount(current.B)}</dd>
            <dt>{zh ? "发布方合计" : "Publisher total"}</dt><dd>{amount(current.publisherTotal)}</dd>
          </dl>
          <p>{zh ? "有效期至" : "Expires"} {new Date(current.expiresAt).toLocaleString(locale)}</p>
          <p>{zh ? "收益仅为模拟；报价确认不发送链上交易。" : "Yield is simulation-only; confirming a quote does not send a blockchain transaction."}</p>
          <button className="button button-primary" type="button" disabled={!walletAddress || busy || expired || confirmation.isSuccess} onClick={() => confirmation.mutate()}>
            {zh ? "确认此报价" : "Confirm this quote"}
          </button>
          <button className="button button-ghost" type="button" disabled={!walletAddress || busy} onClick={() => refresh.mutate()}>
            {zh ? "刷新确认状态" : "Refresh confirmation status"}
          </button>
        </>
      ) : null}
      <p role="status" aria-live="polite">
        {busy ? (zh ? "正在读取服务端状态……" : "Reading server state…")
          : quote.isError || confirmation.isError || refresh.isError ? (zh ? "报价操作未完成，请检查登录与服务状态后重新获取报价。" : "Quote operation incomplete. Check authentication and service availability, then retrieve a fresh quote.")
          : result ? (result.fundingContext
            ? (zh ? "最终报价已确认，注资准备仍由服务端校验。" : "Final quote confirmed. Funding preparation remains server-validated.")
            : (zh ? "尚未满足最终注资条件，请等待所需确认或审批。" : "Final funding conditions remain incomplete; required confirmations or approval are pending."))
          : expired ? (zh ? "报价已过期，请重新获取。" : "Quote expired. Retrieve a fresh quote.") : null}
      </p>
    </Panel>
  );
}
