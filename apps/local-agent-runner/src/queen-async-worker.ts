import type { SNSClient } from "@aws-sdk/client-sns";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Sql } from "postgres";
import { createQueenSnsPublisher, consumeOneQueenSqsMessage } from "./queen-aws-transport";
import { QueenOperationLedger } from "./queen-operation-ledger";
import { publishQueenOutbox } from "./queen-outbox-publisher";
import { createQueenQueuePolicyCheck } from "./queen-queue-policy";
import type { QueenWorkflowEvent } from "./queen-workflow-event";
import { createQueenPlanningAuthorization } from "./queen-planning-authorization";
import { createQueenDurablePlanning } from "./queen-durable-planning";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createQueenPlanningApprovalAuthorization } from "./queen-planning-approval-authorization";
import { createQueenDurableApproval } from "./queen-durable-approval";
import type { QueenTaskGraphPorts } from "./queen-task-graph";
import type { AgentCandidate } from "@agent-market/shared-contracts";

export function createQueenAsyncWorker(options: {
  sql: Sql;
  ledger: QueenOperationLedger;
  sns: SNSClient;
  sqs: SQSClient;
  schema: "queen_runtime_public" | "queen_runtime_owner";
  queueUrl: string;
  queueArn: string;
  topicArn: string;
  deadLetterArn: string;
  maxReceiveCount: number;
  authorizeAndResolve(event: QueenWorkflowEvent): Promise<void>;
  // Resolve only after business results AND recovery state have been persisted.
  executeTask(event: QueenWorkflowEvent): Promise<void>;
}) {
  const publish = createQueenSnsPublisher(options.sns, options.topicArn);
  const assertQueuePolicy = createQueenQueuePolicyCheck(options.sqs, options.queueUrl, {
    queueArn: options.queueArn, topicArn: options.topicArn,
    deadLetterArn: options.deadLetterArn, maxReceiveCount: options.maxReceiveCount,
  });
  return {
    // Caller owns all clients and scheduling. Construction performs no I/O.
    publishPending: (limit = 10) => publishQueenOutbox(options.sql, options.schema, publish, limit),
    consumeOne: () => consumeOneQueenSqsMessage({
      client: options.sqs, queueUrl: options.queueUrl, topicArn: options.topicArn,
      assertQueuePolicy,
      authorizeAndResolve: options.authorizeAndResolve,
      executeDurably: event => options.ledger.execute(event, () => options.executeTask(event)),
    }),
  };
}

// Planning-only production composition. Never reuse this grant for approval,
// agent execution, settlement or another scope's private runtime.
export function createQueenPlanningWorker(options:
  Omit<Parameters<typeof createQueenAsyncWorker>[0], "authorizeAndResolve" | "executeTask" | "schema"> & {
    authorizationSql: Sql;
    checkpointer: PostgresSaver;
    queenAgentId: string;
    agents: AgentCandidate[];
  }) {
  const resolve = createQueenPlanningAuthorization(options.authorizationSql);
  const plan = createQueenDurablePlanning(options);
  return createQueenAsyncWorker({
    ...options, schema: "queen_runtime_public",
    authorizeAndResolve: async event => { await resolve(event); },
    // Recheck after acquiring the operation ledger; do not cache prior authority.
    executeTask: plan,
  });
}

export function createQueenWorkflowWorker(options:
  Omit<Parameters<typeof createQueenAsyncWorker>[0], "authorizeAndResolve" | "executeTask" | "schema"> & {
    authorizationSql: Sql;
    checkpointer: PostgresSaver;
    queenAgentId: string;
    agents: AgentCandidate[];
    ports: QueenTaskGraphPorts;
  }) {
  const resolvePlan = createQueenPlanningAuthorization(options.authorizationSql);
  const resolveApproval = createQueenPlanningApprovalAuthorization(options.authorizationSql);
  const plan = createQueenDurablePlanning(options);
  const approve = createQueenDurableApproval({
    sql: options.authorizationSql,
    checkpointer: options.checkpointer,
    ports: options.ports,
  });
  const authorizeAndResolve = async (event: QueenWorkflowEvent) => {
    if (event.eventType === "task.requested") {
      await resolvePlan(event);
      return;
    }
    if (event.eventType === "task.approval-recorded") {
      await resolveApproval(event);
      return;
    }
    throw new Error("QUEEN_WORKFLOW_EVENT_UNSUPPORTED");
  };
  const executeTask = async (event: QueenWorkflowEvent) => {
    if (event.eventType === "task.requested") return plan(event);
    if (event.eventType === "task.approval-recorded") {
      await approve(event);
      return;
    }
    throw new Error("QUEEN_WORKFLOW_EVENT_UNSUPPORTED");
  };
  return createQueenAsyncWorker({
    ...options,
    schema: "queen_runtime_public",
    authorizeAndResolve,
    executeTask,
  });
}
