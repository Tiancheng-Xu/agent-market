import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  OrderStatus,
  ReputationSnapshot,
  RiskAssessment,
} from "@agent-market/shared-contracts";
import { Link, useParams } from "react-router-dom";

import "../order.css";
import { ReputationV2Panel } from "../components/ReputationV2Panel";
import { RiskQuotePanel } from "../components/RiskQuotePanel";
import { LiveRiskQuotePanel } from "../components/LiveRiskQuotePanel";
import { Badge, DemoNotice, PageHeader, Panel } from "../components/Ui";
import { tasks } from "../data";
import { Localized, useLanguage } from "../i18n/LanguageProvider";
import { executeOrderCommand, readOrder, type BrowserOrderCommand } from "../lib/orderClient";
import { readAgentReputation } from "../lib/riskPricingClient";
import {
  ORDER_LIFECYCLE,
  availableOrderActions,
  lifecycleState,
  type BrowserVisibleOrderAction,
  type OrderViewerRole,
} from "../orderPresentation";
import type { QuoteConfirmationIntent, RiskQuoteViewModel } from "../riskPricingPresentation";
import { orderQueryKeys } from "./orderQueryClient";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const actionLabels: Record<BrowserVisibleOrderAction, string> = {
  mark_funding_pending: "Prepare funding",
  accept_assignment: "Accept assignment",
  submit_artifact: "Submit artifact",
  accept_delivery: "Accept delivery",
  open_dispute: "Open dispute",
};
const shortStep = (status: OrderStatus) => status
  .replace("funding_pending", "funding")
  .replace("manual_review", "review")
  .replace("in_progress", "working");

const fixtureAgentId = "10000000-0000-4000-8000-000000000001";
const fixtureReputation: ReputationSnapshot = {
  agentId: fixtureAgentId,
  score: 52.4,
  rawScore: 74,
  dimensions: {
    deliveryReliability: 82,
    qualityFeedback: 76,
    communicationExperience: 71,
    disputeOutcome: 88,
    experience: 45,
  },
  sampleCount: 4,
  effectiveSampleWeight: 3.4,
  confidenceValue: 4 / 14,
  confidence: "low",
  acceptanceRate: 0.75,
  refundRate: 0,
  disputeRate: 0.25,
  windowDays: 90,
  maxEvents: 20,
  halfLifeDays: 30,
  priorScore: 30,
  formulaVersion: "reputation-v2",
  calculatedAt: "2026-09-01T12:00:00.000Z",
};

const fixtureAssessment: RiskAssessment = {
  factors: {
    complexity: 45,
    acceptanceAmbiguity: 35,
    externalDependency: 40,
    dataSensitivity: 25,
    financialRisk: 45,
    irreversibility: 30,
    deadlineRisk: 40,
    agentUncertainty: 45,
  },
  reasonCodes: ["fixture_external_dependency", "fixture_acceptance_boundary"],
  riskScore: 40,
  riskTier: "R2",
  depositRateBps: 1_000,
  manualReviewRequired: false,
};

const fixtureQuote: RiskQuoteViewModel = {
  quoteId: "20000000-0000-4000-8000-000000000001",
  phase: "preliminary",
  policyVersion: "risk-pricing-v1-fixture",
  taskFingerprint: `sha256:${"a".repeat(64)}`,
  riskScore: 40,
  riskTier: "R2",
  depositRateBps: 1_000,
  serviceFeeBps: 600,
  manualReviewRequired: false,
  reasonCodes: ["fixture_external_dependency", "fixture_acceptance_boundary"],
  P: "1000",
  A: "100",
  B: "60",
  publisherTotal: "1160",
  agentTeamDeposit: "100",
  agentAllocations: [],
  expiresAt: "2099-09-01T12:00:00.000Z",
};

export type OrderReputationState =
  | { kind: "loading" }
  | { kind: "ready"; snapshot: ReputationSnapshot; source: "fixture" | "public-api" }
  | { kind: "unavailable"; reason: "agent-unbound" | "public-api-unavailable" };

export function initialOrderReputationState(isLiveOrder: boolean): OrderReputationState {
  return isLiveOrder
    ? { kind: "loading" }
    : { kind: "ready", snapshot: fixtureReputation, source: "fixture" };
}

export function failedLiveReputationState(): OrderReputationState {
  return { kind: "unavailable", reason: "public-api-unavailable" };
}

function ReputationContent({ state }: { state: OrderReputationState }) {
  const { locale } = useLanguage();
  if (state.kind === "ready") {
    return (
      <div>
        {state.source === "fixture" ? (
          <div className="inline-state warning">
            <strong>UI FIXTURE / SIMULATION_ONLY</strong> {locale === "zh-CN" ? "此确定性汇总仅用于界面验证。" : "Deterministic aggregate for interface validation only."}
          </div>
        ) : null}
        <ReputationV2Panel snapshot={state.snapshot} locale={locale} />
      </div>
    );
  }

  return (
    <Panel className="reputation-card">
      <span className="eyebrow">REPUTATION V2 / PUBLIC AGGREGATE</span>
      <h2>{state.kind === "loading" ? "Loading reputation" : "Reputation unavailable"}</h2>
      <Badge tone={state.kind === "loading" ? "neutral" : "amber"}>
        {state.kind === "loading" ? "PUBLIC API" : "UNAVAILABLE"}
      </Badge>
      <p>
        {state.kind === "loading"
          ? "Waiting for the exact Agent ID before reading the privacy-safe aggregate."
          : state.reason === "agent-unbound"
            ? "This order has no exact Agent ID, so no reputation request was sent."
            : "The public Reputation V2 source is unavailable. No fixture or wallet-derived value is substituted."}
      </p>
    </Panel>
  );
}

function RiskPricingContent({
  isLiveOrder,
  onConfirmIntent,
}: {
  isLiveOrder: boolean;
  onConfirmIntent?: (intent: QuoteConfirmationIntent) => void;
}) {
  const { locale } = useLanguage();
  if (!isLiveOrder) {
    return (
      <div>
        <div className="inline-state warning">
          <strong>UI FIXTURE / SIMULATION_ONLY</strong> {locale === "zh-CN" ? "此模拟报价不能授权注资，也不代表 Sepolia 合约已经执行。" : "This deterministic quote does not authorize funding or claim Sepolia enforcement."}
        </div>
        <RiskQuotePanel
          quote={fixtureQuote}
          assessment={fixtureAssessment}
          locale={locale}
          now="2026-09-01T12:00:00.000Z"
          {...(onConfirmIntent ? { onConfirmIntent } : {})}
        />
      </div>
    );
  }

  return (
    <Panel className="risk-quote-panel">
      <span className="eyebrow">RISK PRICING / SERVER AUTHORITY</span>
      <h2>Dynamic quote unavailable</h2>
      <Badge tone="amber">DATA SOURCE NOT CONFIGURED</Badge>
      <p>
        This projection does not expose an authoritative current quote and task fingerprint. No quote request was sent,
        and no client-generated rate, deposit or fee is presented as live.
      </p>
    </Panel>
  );
}

export function OrderDetailPage({ walletAddress = null }: { walletAddress?: string | null }) {
  const { locale } = useLanguage();
  const { id = "" } = useParams();
  const fixture = tasks.find((item) => item.id === id) ?? tasks[0]!;
  const isLiveOrder = uuidPattern.test(id);
  const queryClient = useQueryClient();
  const [fixtureActionAttempted, setFixtureActionAttempted] = useState(false);
  const [artifactUri, setArtifactUri] = useState("");
  const [artifactHash, setArtifactHash] = useState("");
  const [confirmedQuoteContext, setConfirmedQuoteContext] = useState<QuoteConfirmationIntent | null>(null);

  const orderQuery = useQuery({
    queryKey: orderQueryKeys.order(id),
    queryFn: () => readOrder(id),
    enabled: isLiveOrder,
  });
  const order = orderQuery.data ?? null;
  const reputationQuery = useQuery({
    queryKey: orderQueryKeys.reputation(order?.agentId ?? "unbound"),
    queryFn: () => {
      if (!order?.agentId) throw new Error("REPUTATION_AGENT_ID_UNAVAILABLE");
      return readAgentReputation(order.agentId);
    },
    enabled: isLiveOrder && Boolean(order?.agentId),
  });
  const reputation: OrderReputationState = !isLiveOrder
    ? initialOrderReputationState(false)
    : orderQuery.isError
      ? failedLiveReputationState()
      : !order
        ? { kind: "loading" }
        : !order.agentId
          ? { kind: "unavailable", reason: "agent-unbound" }
          : reputationQuery.data
            ? { kind: "ready", snapshot: reputationQuery.data, source: "public-api" }
            : reputationQuery.isError
              ? failedLiveReputationState()
              : { kind: "loading" };

  const commandMutation = useMutation({
    mutationFn: (command: BrowserOrderCommand) => executeOrderCommand(id, command),
    onSuccess: async (updated) => {
      queryClient.setQueryData(orderQueryKeys.order(id), updated);
      await queryClient.invalidateQueries({ queryKey: orderQueryKeys.order(id) });
      if (updated.agentId) {
        await queryClient.invalidateQueries({ queryKey: orderQueryKeys.reputation(updated.agentId) });
      }
    },
  });

  const status = (order?.status ?? fixture.status) as OrderStatus;
  const role = useMemo<OrderViewerRole>(() => {
    if (!walletAddress || !order) return "visitor";
    const wallet = walletAddress.toLowerCase();
    if (wallet === order.publisherWallet.toLowerCase()) return "publisher";
    if (wallet === order.agentWallet?.toLowerCase()) return "agent";
    return "visitor";
  }, [order, walletAddress]);
  const actions = availableOrderActions(status, role);
  const visibleActions = actions.filter((action) => action !== "mark_funding_pending" || confirmedQuoteContext !== null);
  const title = order?.title ?? fixture.title;
  const budget = order?.budgetAtomic ?? String(fixture.budget);

  function runAction(action: BrowserVisibleOrderAction) {
    if (!isLiveOrder) {
      setFixtureActionAttempted(true);
      return;
    }
    let command: BrowserOrderCommand;
    if (action === "submit_artifact") {
      command = {
        type: action,
        artifact: {
          id: crypto.randomUUID(),
          uri: artifactUri,
          contentHash: artifactHash,
          mediaType: "application/json",
          sizeBytes: 1,
          submittedAt: new Date().toISOString(),
        },
      };
    } else if (action === "open_dispute") command = { type: action, reasonCode: "DELIVERY_ACCEPTANCE_DISPUTED" };
    else if (action === "mark_funding_pending") {
      if (!confirmedQuoteContext) return;
      command = { type: action, ...confirmedQuoteContext };
    }
    else command = { type: action };
    commandMutation.mutate(command);
  }

  const message = !isLiveOrder
    ? fixtureActionAttempted
      ? "Fixture actions are disabled. Open an authenticated UUID order to execute."
      : "Interface fixture: no runtime or chain state is claimed."
    : commandMutation.isPending
      ? "Submitting authenticated order command..."
      : commandMutation.isError
        ? "ORDER_COMMAND_UNAVAILABLE"
        : commandMutation.data
          ? `Order advanced to ${commandMutation.data.status}; authenticated projection refreshed.`
          : orderQuery.isError
            ? "ORDER_READ_UNAVAILABLE"
            : order
              ? "Authenticated order projection loaded."
              : "Loading authenticated order projection...";
  const busy = commandMutation.isPending;

  if (isLiveOrder && !order) {
    return (
      <Localized>
        <Panel>
          <h1>{orderQuery.isError ? "Order unavailable" : "Loading order"}</h1>
          <p>{orderQuery.isError
            ? "The authenticated order could not be loaded. Check the participant wallet and try again."
            : "Waiting for the authenticated order before showing its budget, status and actions."}</p>
          {orderQuery.isError ? (
            <button className="button button-primary" type="button" disabled={orderQuery.isFetching} onClick={() => void orderQuery.refetch()}>
              Retry order
            </button>
          ) : <span role="status" aria-busy="true">Loading</span>}
        </Panel>
      </Localized>
    );
  }

  return (
    <Localized>
      <>
        <PageHeader
          eyebrow={`ORDER / ${id}`}
          title={title}
          description={order ? "Authenticated database projection with role-scoped actions." : fixture.summary}
          actions={(
            <>
              <Badge tone={status === "manual_review" || status === "disputed" ? "amber" : "cyan"}>{status.toUpperCase()}</Badge>
              <Badge tone={isLiveOrder ? "indigo" : "neutral"}>{isLiveOrder ? "LIVE API" : "UI FIXTURE"}</Badge>
            </>
          )}
        />
        {!isLiveOrder ? <DemoNotice /> : null}
        <div className="order-overview-grid">
          <Panel className="order-contract-card">
            <span className="eyebrow">{locale === "zh-CN" ? "验收约定" : "ACCEPTANCE CONTRACT"}</span>
            <h2>{locale === "zh-CN" ? "先验证证据，再结算" : "Evidence before settlement"}</h2>
            <ul className="detail-list">
              <li>Deliverable matches the requested structured format.</li>
              <li>Artifact carries a content hash, media type, size and timestamp.</li>
              <li>No secret or personal data enters the public artifact.</li>
            </ul>
            <div className="tag-row">{fixture.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          </Panel>
          <Panel className="money-panel">
            <span>Escrow budget</span>
            <strong>{budget} YD atomic</strong>
            <small>{status === "manual_review" ? "Unknown settlement state; manual review required" : "Receipt verification remains separate from UI state"}</small>
            <Link className="button button-primary" to={`/tasks/${id}/matches`}>{locale === "zh-CN" ? "查看可解释匹配" : "View explainable matches"}</Link>
          </Panel>
          <div className="order-reputation"><ReputationContent state={reputation} /></div>
        </div>
        {isLiveOrder ? <LiveRiskQuotePanel taskId={id} walletAddress={walletAddress} canRequote={role === "publisher"} onFundingReady={setConfirmedQuoteContext} /> : <RiskPricingContent isLiveOrder={false} />}
        <Panel className="order-lifecycle-panel">
          <div className="order-section-heading">
            <div><span className="eyebrow">{locale === "zh-CN" ? "账本投影" : "LEDGER PROJECTION"}</span><h2>{locale === "zh-CN" ? "订单生命周期" : "Order lifecycle"}</h2></div>
            <Badge tone={status === "manual_review" ? "amber" : "neutral"}>VERSION {order?.version ?? 1}</Badge>
          </div>
          <div className="order-lifecycle" aria-label={locale === "zh-CN" ? "订单生命周期" : "Order lifecycle"}>
            {ORDER_LIFECYCLE.map((step) => <div className={lifecycleState(step, status)} key={step}><i /><span>{shortStep(step)}</span></div>)}
          </div>
          {order?.manualReview ? <div className="inline-state warning"><strong>Manual review:</strong> {order.manualReview.reasonCode} · previous state {order.manualReview.previousStatus}</div> : null}
        </Panel>
        <div className="two-column order-action-grid">
          <Panel>
            <span className="eyebrow">{locale === "zh-CN" ? "角色权限操作" : "ROLE-SCOPED ACTIONS"}</span>
            <h2>{role === "visitor"
              ? (locale === "zh-CN" ? "连接参与方钱包" : "Connect the participant wallet")
              : locale === "zh-CN"
                ? role === "publisher" ? "发布方操作" : "Agent 操作"
                : `${role} controls`}</h2>
            {visibleActions.length ? (
              <div className="form-actions">
                {visibleActions.filter((action) => action !== "submit_artifact").map((action) => (
                  <button className={action === "open_dispute" ? "button button-warning" : "button button-primary"} disabled={busy} key={action} onClick={() => void runAction(action)}>{actionLabels[action]}</button>
                ))}
              </div>
            ) : <p className="muted">No browser action is allowed for this role and state. System projection commands remain server-only.</p>}
            {actions.includes("submit_artifact") ? (
              <div className="artifact-submit">
                <label>Artifact URL<input value={artifactUri} onChange={(event) => setArtifactUri(event.target.value)} placeholder="https://.../evidence.json" /></label>
                <label>SHA-256<input value={artifactHash} onChange={(event) => setArtifactHash(event.target.value)} placeholder="sha256:..." /></label>
                <button className="button button-primary" disabled={busy || !artifactUri || !artifactHash} onClick={() => void runAction("submit_artifact")}>Submit hashed artifact</button>
              </div>
            ) : null}
            <div className="inline-state" role="status" aria-live="polite">{message}</div>
          </Panel>
          <Panel>
            <span className="eyebrow">{locale === "zh-CN" ? "交付与评价" : "DELIVERY & REVIEW"}</span>
            <h2>{locale === "zh-CN" ? "满足条件后获得评价资格" : "Eligibility is earned"}</h2>
            <p>Only an accepted delivery grants the publisher one review. Self-review, linked wallets, duplicate reviews and non-accepted orders are rejected.</p>
            <div className="evidence-list">
              <span><b>{order?.artifacts.length ?? 0}</b> {locale === "zh-CN" ? "项交付物" : "artifacts"}</span>
              <span><b>{order?.reviewEligible ? "YES" : "NO"}</b> {locale === "zh-CN" ? "可评价" : "review eligible"}</span>
              <span><b>{order?.agentId ? "BOUND" : "NONE"}</b> {locale === "zh-CN" ? "精确 Agent ID" : "exact Agent ID"}</span>
            </div>
            <div className="form-actions">
              <Link className="button button-ghost" to={`/tasks/${id}/workspace`}>{locale === "zh-CN" ? "打开办公室工位" : "Open Office desk"}</Link>
              {status === "disputed" ? <Link className="button button-warning" to={`/disputes/${id}`}>Review dispute</Link> : null}
            </div>
          </Panel>
        </div>
      </>
    </Localized>
  );
}
