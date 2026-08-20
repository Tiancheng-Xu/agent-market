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
});
