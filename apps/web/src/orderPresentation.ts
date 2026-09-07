import type { OrderStatus } from "@agent-market/shared-contracts";

export const ORDER_LIFECYCLE: readonly OrderStatus[] = [
  "open", "funding_pending", "funded", "matching", "assigned", "in_progress",
  "submitted", "accepted", "disputed", "settled", "refunded", "manual_review",
];

export type OrderViewerRole = "publisher" | "agent" | "visitor";
// Includes the legacy label key consumed by the page copy map. Browser-visible
// actions are deliberately narrower and never expose system-owned transitions.
export type PublicOrderAction = "mark_funding_pending" | "start_matching" | "accept_assignment" | "submit_artifact" | "accept_delivery" | "open_dispute";
export type BrowserVisibleOrderAction = Exclude<PublicOrderAction, "start_matching">;

export function availableOrderActions(status: OrderStatus, role: OrderViewerRole): BrowserVisibleOrderAction[] {
  if (role === "publisher" && status === "open") return ["mark_funding_pending"];
  if (role === "agent" && status === "assigned") return ["accept_assignment"];
  if (role === "agent" && status === "in_progress") return ["submit_artifact"];
  if (role === "publisher" && status === "submitted") return ["accept_delivery", "open_dispute"];
  return [];
}

export function lifecycleState(step: OrderStatus, status: OrderStatus): "done" | "active" | "pending" | "exception" {
  if (status === "manual_review") return step === "manual_review" ? "exception" : "pending";
  if (status === "refunded") return step === "refunded" ? "exception" : "pending";
  const current = ORDER_LIFECYCLE.indexOf(status);
  const position = ORDER_LIFECYCLE.indexOf(step);
  if (position === current) return status === "disputed" ? "exception" : "active";
  return position < current ? "done" : "pending";
}

export function reputationConfidence(sampleCount: number): "low" | "medium" | "high" {
  if (sampleCount < 5) return "low";
  if (sampleCount < 15) return "medium";
  return "high";
}
