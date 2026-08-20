export type TaskStatus =
  | "open"
  | "matching"
  | "assigned"
  | "in_progress"
  | "submitted"
  | "accepted";

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
}

export interface TaskTransitionResult {
  taskId: string;
  requestId: string;
  status: TaskStatus;
  version: number;
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
    return this.transition(requestId, "open", "matching");
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
    if (this.state.publisherId !== publisherId) {
      throw new Error("TASK_PUBLISHER_FORBIDDEN");
    }
    return this.transition(requestId, "submitted", "accepted");
  }

  private transition(
    requestId: string,
    expected: TaskStatus,
    next: TaskStatus,
    mutate?: () => void,
  ): TaskTransitionResult {
    const existing = this.requestResults.get(requestId);
    if (existing) {
      return existing;
    }
    if (this.state.status !== expected) {
      throw new Error("TASK_TRANSITION_INVALID");
    }

    mutate?.();
    this.state.status = next;
    this.state.version += 1;
    const result = this.result(requestId);
    this.requestResults.set(requestId, result);
    return result;
  }

  private result(requestId: string): TaskTransitionResult {
    return {
      taskId: this.state.id,
      requestId,
      status: this.state.status,
      version: this.state.version,
    };
  }
}
