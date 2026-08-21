export type TaskStatus =
  | "open"
  | "funding_pending"
  | "funded"
  | "matching"
  | "assigned"
  | "in_progress"
  | "submitted"
  | "accepted"
  | "disputed"
  | "settled"
  | "refunded";

export interface CreateTaskInput {
  id: string;
  publisherId: string;
  title: string;
  budgetAtomic: bigint;
  requestId: string;
}

export interface TaskSnapshot {
  id: string;
  publisherId: string;
  title: string;
  budgetAtomic: bigint;
  status: TaskStatus;
  agentId?: string;
  deliveryUri?: string;
  version: number;
  refundScope?: "budget_only";
  bondDisposition?: "not_applicable" | "platform_treasury";
}

export interface TaskTransitionResult {
  taskId: string;
  requestId: string;
  status: TaskStatus;
  version: number;
  refundScope?: "budget_only";
  bondDisposition?: "not_applicable" | "platform_treasury";
}

export class TaskAggregate {
  private state: TaskSnapshot;
  private readonly requestResults = new Map<string, TaskTransitionResult>();

  private constructor(input: CreateTaskInput) {
    if (input.budgetAtomic <= 0n) {
      throw new Error("TASK_BUDGET_INVALID");
    }

    this.state = {
      id: input.id,
      publisherId: input.publisherId,
      title: input.title,
      budgetAtomic: input.budgetAtomic,
      status: "open",
      version: 1,
    };
    this.requestResults.set(input.requestId, this.result(input.requestId));
  }

  static create(input: CreateTaskInput): TaskAggregate {
    return new TaskAggregate(input);
  }

  snapshot(): Readonly<TaskSnapshot> {
    return { ...this.state };
  }

  startMatching(requestId: string): TaskTransitionResult {
    return this.transition(requestId, ["open", "funded"], "matching");
  }

  markFundingPending(publisherId: string, requestId: string): TaskTransitionResult {
    this.requirePublisher(publisherId);
    return this.transition(requestId, "open", "funding_pending");
  }

  markFunded(publisherId: string, requestId: string): TaskTransitionResult {
    this.requirePublisher(publisherId);
    return this.transition(requestId, "funding_pending", "funded");
  }

  assign(agentId: string, requestId: string): TaskTransitionResult {
    return this.transition(requestId, "matching", "assigned", () => {
      this.state.agentId = agentId;
    });
  }

  acceptAssignment(agentId: string, requestId: string): TaskTransitionResult {
    if (this.state.agentId !== agentId) {
      throw new Error("TASK_AGENT_FORBIDDEN");
    }
    return this.transition(requestId, "assigned", "in_progress");
  }

  submit(
    agentId: string,
    deliveryUri: string,
    requestId: string,
  ): TaskTransitionResult {
    if (this.state.status === "in_progress" && this.state.agentId !== agentId) {
      throw new Error("TASK_AGENT_FORBIDDEN");
    }
    return this.transition(requestId, "in_progress", "submitted", () => {
      this.state.deliveryUri = deliveryUri;
    });
  }

  acceptDelivery(publisherId: string, requestId: string): TaskTransitionResult {
    this.requirePublisher(publisherId);
    return this.transition(requestId, "submitted", "accepted");
  }

  openDispute(requestId: string): TaskTransitionResult {
    return this.transition(requestId, "submitted", "disputed");
  }

  settle(requestId: string): TaskTransitionResult {
    return this.transition(requestId, ["accepted", "disputed"], "settled");
  }

  refundBudget(publisherId: string, requestId: string): TaskTransitionResult {
    this.requirePublisher(publisherId);
    const bondExists = ["in_progress", "submitted", "disputed"].includes(this.state.status);
    return this.transition(requestId, ["funded", "assigned", "in_progress", "submitted", "disputed"], "refunded", () => {
      this.state.refundScope = "budget_only";
      this.state.bondDisposition = bondExists ? "platform_treasury" : "not_applicable";
    });
  }

  private transition(
    requestId: string,
    expected: TaskStatus | readonly TaskStatus[],
    next: TaskStatus,
    mutate?: () => void,
  ): TaskTransitionResult {
    const existing = this.requestResults.get(requestId);
    if (existing) {
      return existing;
    }
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(this.state.status)) {
      throw new Error("TASK_TRANSITION_INVALID");
    }

    mutate?.();
    this.state.status = next;
    this.state.version += 1;
    const result = this.result(requestId);
    this.requestResults.set(requestId, result);
    return result;
  }

  private requirePublisher(publisherId: string): void {
    if (this.state.publisherId !== publisherId) {
      throw new Error("TASK_PUBLISHER_FORBIDDEN");
    }
  }

  private result(requestId: string): TaskTransitionResult {
    return {
      taskId: this.state.id,
      requestId,
      status: this.state.status,
      version: this.state.version,
      ...(this.state.refundScope ? { refundScope: this.state.refundScope } : {}),
      ...(this.state.bondDisposition ? { bondDisposition: this.state.bondDisposition } : {}),
    };
  }
}
