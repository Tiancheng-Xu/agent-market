import postgres, { type Sql } from "postgres";

import { OrderService } from "./order-service";
import { PostgresOrderStore } from "./postgres-order-store";
import type { ReputationStore } from "./reputation-service";
import { PostgresReputationV2Store } from "./postgres-reputation-v2-store";
import { PostgresRiskTaskSource } from "./postgres-risk-task-source";
import { RiskPricingService } from "./risk-pricing-service";
import { PostgresRiskQuoteStore } from "./risk-quote-store";

export interface OrderRuntime {
  sql: Sql;
  store: PostgresOrderStore;
  quoteStore: PostgresRiskQuoteStore;
  riskPricing: RiskPricingService;
  reputationStore?: ReputationStore;
  service: OrderService;
}

let runtime: OrderRuntime | undefined;

export function getOrderRuntime(): OrderRuntime {
  if (runtime) return runtime;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("ORDER_STORE_UNAVAILABLE");
  const sql = postgres(databaseUrl, { max: 5, prepare: false });
  const store = new PostgresOrderStore(sql);
  const quoteStore = new PostgresRiskQuoteStore(sql);
  const riskTaskSource = new PostgresRiskTaskSource(sql);
  const reputationStore = new PostgresReputationV2Store(sql);
  runtime = {
    sql,
    store,
    quoteStore,
    riskPricing: new RiskPricingService({ quotes: quoteStore, tasks: riskTaskSource }),
    reputationStore,
    service: new OrderService(store, quoteStore),
  };
  return runtime;
}

export function resetOrderRuntimeForTests(): void {
  runtime = undefined;
}
