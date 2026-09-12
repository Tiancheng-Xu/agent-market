// This adapter belongs to the Node-only Transaction Engine, never shared-contracts/Web.
import { buildSchema, execute, Kind, parse, validate, visit, type DocumentNode } from "graphql";
import { AuthError, readSessionCookie, type WalletAuthService } from "../auth/session";
import type { recordQueenPlanningApproval } from "./queen-planning-approval";
import { QueenPlanningError, type requestQueenPlanning } from "./queen-planning-request";
import type { readQueenPlanningStatus } from "./queen-planning-status";

export interface QueenGraphqlGatewayOptions {
  authOrigin: URL;
  auth: Pick<WalletAuthService, "authenticateSession">;
  planningEnabled: boolean;
  workerReady: boolean;
  propose(input: Parameters<typeof requestQueenPlanning>[1]): ReturnType<typeof requestQueenPlanning>;
  confirm(input: Parameters<typeof recordQueenPlanningApproval>[1]): ReturnType<typeof recordQueenPlanningApproval>;
  read(input: Parameters<typeof readQueenPlanningStatus>[1]): ReturnType<typeof readQueenPlanningStatus>;
}

const MAX_BODY_BYTES = 32_768;
const headers = { "cache-control": "no-store", vary: "Cookie, Origin" };

const schema = buildSchema(`
  input ProposeTaskGraphInput { taskId: ID!, taskVersion: Int! }
  input ConfirmTaskGraphInput {
    taskId: ID!, requestId: ID!, taskVersion: Int!, graphRevision: Int!
    taskFingerprint: String!, approved: Boolean!
  }
  type PlanningQueued { requestId: ID!, status: String!, duplicate: Boolean! }
  type ApprovalQueued { approvalId: ID!, status: String!, duplicate: Boolean! }
  type PlanningTask { taskId: ID!, taskVersion: Int!, status: String! }
  type PlanningApproval {
    approvalId: ID!, approved: Boolean!, authorizationCurrent: Boolean!, operationStatus: String!
  }
  type NodeContract {
    schemaVersion: String!, contextInputs: [String!]!, outputKeys: [String!]!
    artifactMediaTypes: [String!]!, milestone: String!, acceptanceCriteria: [String!]!
    budgetAtomic: String!, permissions: [String!]!, timeoutSeconds: Int!, failureRoute: String!
  }
  type TaskNode {
    nodeId: String!, type: String!, title: String!, dependencies: [String!]!, required: Boolean!
    judgesNodeId: String, repairsNodeId: String, assignedAgentId: String, contract: NodeContract!
  }
  type TaskEdge { from: String!, to: String!, condition: String }
  type RescuePolicy { mode: String!, visibleToUser: Boolean!, evidenceVisible: Boolean! }
  type TaskGraph {
    taskId: ID!, graphRevision: Int!, requiredStages: [String!]!, riskLevel: String!, startPolicy: String!
    nodes: [TaskNode!]!, edges: [TaskEdge!]!, rescuePolicy: RescuePolicy!
  }
  type PlanningPlan { recordVersion: Int!, graph: TaskGraph! }
  type PlanningRequest {
    requestId: ID!, taskVersion: Int!, authorizationCurrent: Boolean!, graphRevision: Int!
    taskFingerprint: String!, planningOperationStatus: String!, plan: PlanningPlan, approval: PlanningApproval
  }
  type PlanningStatus {
    task: PlanningTask!, request: PlanningRequest, canApprove: Boolean!, executionVerified: Boolean!
  }
  type Query { planningStatus(taskId: ID!): PlanningStatus! }
  type Mutation {
    proposeTaskGraph(input: ProposeTaskGraphInput!): PlanningQueued!
    confirmTaskGraph(input: ConfirmTaskGraphInput!): ApprovalQueued!
  }
`);

// Domain error codes are allowlisted; neither arbitrary messages nor caller-supplied
// domain error statuses are exposed. GraphQL paths, locations and stacks stay private.
const errorStatuses = new Map<string, number>([
  ["METHOD_NOT_ALLOWED", 405], ["QUEEN_GRAPHQL_INVALID", 400],
  ["QUEEN_GRAPHQL_TOO_LARGE", 413], ["QUEEN_GRAPHQL_MEDIA_TYPE", 415],
  ["QUEEN_GRAPHQL_OPERATION_FORBIDDEN", 403], ["QUEEN_GRAPHQL_UNAVAILABLE", 503],
  ["AUTH_ORIGIN_MISMATCH", 403], ["AUTH_SESSION_INVALID", 401], ["AUTH_STORE_UNAVAILABLE", 503],
  ["QUEEN_ASYNC_PLANNING_DISABLED", 503], ["QUEEN_PLANNING_INPUT_INVALID", 400],
  ["QUEEN_TASK_UNAVAILABLE", 404], ["QUEEN_TASK_VERSION_OR_STATE_CONFLICT", 409],
  ["QUEEN_PLANNING_RECONCILIATION_REQUIRED", 409], ["QUEEN_PLANNING_STATE_INVALID", 503],
  ["QUEEN_APPROVAL_INPUT_INVALID", 400], ["QUEEN_APPROVAL_TASK_CONFLICT", 409],
  ["QUEEN_APPROVAL_VERSION_MISMATCH", 409], ["QUEEN_APPROVAL_DECISION_CONFLICT", 409],
  ["QUEEN_APPROVAL_PLAN_NOT_READY", 409],
]);

class GatewayError extends Error {
  constructor(readonly code: string) { super(code); }
}

function failure(code: string): Response {
  return Response.json({ data: null, errors: [{ message: code, extensions: { code } }] }, {
    status: errorStatuses.get(code) ?? 503,
    headers: { ...headers, ...(code === "METHOD_NOT_ALLOWED" ? { allow: "POST" } : {}) },
  });
}

function sanitizedFailure(error: unknown): Response {
  if ((error instanceof GatewayError || error instanceof AuthError || error instanceof QueenPlanningError)
      && errorStatuses.has(error.code)) return failure(error.code);
  return queenGraphqlUnavailable();
}

export function queenGraphqlUnavailable(): Response { return failure("QUEEN_GRAPHQL_UNAVAILABLE"); }
export function queenGraphqlMethodNotAllowed(): Response { return failure("METHOD_NOT_ALLOWED"); }

function invalid(): never { throw new GatewayError("QUEEN_GRAPHQL_INVALID"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/u.test(length)) invalid();
    if (Number(length) > MAX_BODY_BYTES) throw new GatewayError("QUEEN_GRAPHQL_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (!reader) invalid();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new GatewayError("QUEEN_GRAPHQL_TOO_LARGE");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const value: unknown = JSON.parse(body);
    if (!record(value)) invalid();
    return value;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    return invalid();
  } finally {
    reader.releaseLock();
  }
}

function documentFor(body: Record<string, unknown>): DocumentNode {
  if (Object.keys(body).some(key => !["query", "operationName", "variables"].includes(key))
      || typeof body.query !== "string"
      || (body.operationName !== undefined && typeof body.operationName !== "string")
      || (body.variables !== undefined && body.variables !== null && !record(body.variables))) invalid();
  let document: DocumentNode;
  try { document = parse(body.query, { maxTokens: 1024 }); } catch { return invalid(); }
  const operation = document.definitions[0];
  if (document.definitions.length !== 1 || operation?.kind !== Kind.OPERATION_DEFINITION
      || (operation.operation !== "query" && operation.operation !== "mutation")
      || operation.selectionSet.selections.length !== 1
      || (body.operationName !== undefined && body.operationName !== operation.name?.value)) invalid();

  let depth = 0;
  let fields = 0;
  visit(document, {
    Field(node) {
      if (node.alias || node.name.value.startsWith("__") || ++fields > 100) invalid();
    },
    FragmentSpread: invalid,
    InlineFragment: invalid,
    Directive: invalid,
    SelectionSet: { enter() { if (++depth > 12) invalid(); }, leave() { depth -= 1; } },
  });
  const root = operation.selectionSet.selections[0];
  if (root?.kind !== Kind.FIELD) invalid();
  if (!["proposeTaskGraph", "confirmTaskGraph", "planningStatus"].includes(root.name.value)) {
    throw new GatewayError("QUEEN_GRAPHQL_OPERATION_FORBIDDEN");
  }
  const variables = new Set(operation.variableDefinitions?.map(item => item.variable.name.value));
  if (record(body.variables) && Object.keys(body.variables).some(key => !variables.has(key))) invalid();
  if (validate(schema, document, undefined, { maxErrors: 1 }).length > 0) invalid();
  return document;
}

export function createQueenGraphqlGateway(options: QueenGraphqlGatewayOptions) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "POST") return queenGraphqlMethodNotAllowed();
      if (request.headers.get("origin") !== options.authOrigin.origin
          || request.headers.get("sec-fetch-site") === "cross-site") throw new AuthError("AUTH_ORIGIN_MISMATCH", 403);
      if (new URL(request.url).search) invalid();
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new GatewayError("QUEEN_GRAPHQL_MEDIA_TYPE");
      }
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await options.auth.authenticateSession(token);
      const actorWallet = session.walletAddress;
      const body = await readBody(request);
      const document = documentFor(body);
      let resolverEntered = false;
      const requireProducer = () => {
        if (!options.planningEnabled || !options.workerReady) throw new GatewayError("QUEEN_ASYNC_PLANNING_DISABLED");
      };
      const result = await execute({
        schema, document,
        variableValues: (body.variables ?? {}) as Record<string, unknown>,
        ...(typeof body.operationName === "string" ? { operationName: body.operationName } : {}),
        rootValue: {
          proposeTaskGraph({ input }: { input: { taskId: string; taskVersion: number } }) {
            resolverEntered = true;
            requireProducer();
            return options.propose({ taskId: input.taskId, expectedTaskVersion: input.taskVersion, actorWallet });
          },
          confirmTaskGraph({ input }: { input: {
            taskId: string; requestId: string; taskVersion: number; graphRevision: number;
            taskFingerprint: string; approved: boolean;
          } }) {
            resolverEntered = true;
            requireProducer();
            return options.confirm({ taskId: input.taskId, requestId: input.requestId,
              expectedTaskVersion: input.taskVersion, graphRevision: input.graphRevision,
              taskFingerprint: input.taskFingerprint, approved: input.approved, actorWallet });
          },
          planningStatus({ taskId }: { taskId: string }) {
            resolverEntered = true;
            return options.read({ taskId, actorWallet });
          },
        },
      });
      if (result.errors?.length) {
        return resolverEntered ? sanitizedFailure(result.errors[0]?.originalError) : failure("QUEEN_GRAPHQL_INVALID");
      }
      return Response.json({ data: result.data }, { headers });
    } catch (error) {
      return sanitizedFailure(error);
    }
  };
}
