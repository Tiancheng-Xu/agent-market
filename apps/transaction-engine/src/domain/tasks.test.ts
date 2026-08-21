import { describe, expect, it } from "vitest";

import { TaskAggregate } from "./tasks";

describe("task aggregate", () => {
  it("enforces the delivery lifecycle", () => {
    const task = TaskAggregate.create({
      id: "task-01",
      publisherId: "publisher-01",
      title: "Research the market",
      budgetAtomic: 100_000n,
      requestId: "req-create-01",
    });

    task.startMatching("req-match-01");
    task.assign("agent-research-01", "req-assign-01");
    task.acceptAssignment("agent-research-01", "req-accept-01");
    task.submit("agent-research-01", "ipfs://delivery", "req-submit-01");
    task.acceptDelivery("publisher-01", "req-delivery-01");

    expect(task.snapshot()).toMatchObject({
      status: "accepted",
      agentId: "agent-research-01",
      deliveryUri: "ipfs://delivery",
      version: 6,
    });
  });

  it("returns the original result for a repeated request_id", () => {
    const task = TaskAggregate.create({
      id: "task-02",
      publisherId: "publisher-01",
      title: "Summarize sources",
      budgetAtomic: 50_000n,
      requestId: "req-create-02",
    });

    const first = task.startMatching("req-match-02");
    const repeated = task.startMatching("req-match-02");

    expect(repeated).toEqual(first);
    expect(task.snapshot().version).toBe(2);
  });

  it("rejects invalid transitions", () => {
    const task = TaskAggregate.create({
      id: "task-03",
      publisherId: "publisher-01",
      title: "Invalid transition case",
      budgetAtomic: 10_000n,
      requestId: "req-create-03",
    });

    expect(() => task.submit("agent-01", "ipfs://delivery", "req-submit-03"))
      .toThrowError("TASK_TRANSITION_INVALID");
  });

  it("tracks funding, dispute, settlement, and budget-only refund states idempotently", () => {
    const funded = TaskAggregate.create({
      id: "task-04", publisherId: "publisher-01", title: "Funded task",
      budgetAtomic: 20_000n, requestId: "req-create-04",
    });
    funded.markFundingPending("publisher-01", "req-funding-04");
    const fundingResult = funded.markFunded("publisher-01", "req-funded-04");
    expect(funded.markFunded("publisher-01", "req-funded-04")).toEqual(fundingResult);
    funded.startMatching("req-match-04");
    funded.assign("agent-04", "req-assign-04");
    funded.acceptAssignment("agent-04", "req-accept-04");
    funded.submit("agent-04", "ipfs://delivery-04", "req-submit-04");
    funded.openDispute("req-dispute-04");
    funded.settle("req-settle-04");
    expect(funded.snapshot().status).toBe("settled");

    const refundable = TaskAggregate.create({
      id: "task-05", publisherId: "publisher-01", title: "Refund budget",
      budgetAtomic: 30_000n, requestId: "req-create-05",
    });
    refundable.markFundingPending("publisher-01", "req-funding-05");
    refundable.markFunded("publisher-01", "req-funded-05");
    refundable.refundBudget("publisher-01", "req-refund-05");
    expect(refundable.snapshot()).toMatchObject({
      status: "refunded",
      refundScope: "budget_only",
      bondDisposition: "not_applicable",
    });
    expect(() => refundable.refundBudget("attacker", "req-refund-attack"))
      .toThrow("TASK_PUBLISHER_FORBIDDEN");

    const bonded = TaskAggregate.create({
      id: "task-06", publisherId: "publisher-01", title: "Bonded refund",
      budgetAtomic: 30_000n, requestId: "req-create-06",
    });
    bonded.startMatching("req-match-06");
    bonded.assign("agent-06", "req-assign-06");
    bonded.acceptAssignment("agent-06", "req-accept-06");
    expect(bonded.refundBudget("publisher-01", "req-refund-06")).toMatchObject({
      refundScope: "budget_only",
      bondDisposition: "platform_treasury",
    });
  });
});
