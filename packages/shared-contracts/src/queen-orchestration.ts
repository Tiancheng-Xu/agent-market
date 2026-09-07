import { z } from "zod";

export const WorkflowStageSchema = z.enum([
  "requirement",
  "graph",
  "ranking",
  "acceptance",
  "execution",
  "judge",
  "final_arbitration",
  "delivery",
]);

export const RequiredWorkflowStages = [
  "requirement",
  "graph",
  "ranking",
  "acceptance",
  "execution",
  "judge",
  "final_arbitration",
  "delivery",
] as const;

export const TaskNodeTypeSchema = z.enum([
  "plan",
  "research",
  "execute",
  "critique",
  "judge",
  "red_team",
  "repair",
  "synthesize",
  "deliver",
  "custom",
]);

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export const StartPolicySchema = z.enum(["auto", "manualRequired"]);

export const AssignmentStatusSchema = z.enum([
  "candidate_ranked",
  "selected",
  "accepted",
  "rejected",
  "offline",
  "timeout",
]);

export const NodePermissionSchema = z.enum([
  "read_context",
  "write_artifact",
  "call_provider",
  "call_local_runtime",
  "request_review",
]);

export const NodeFailureRouteSchema = z.enum([
  "retry",
  "repair",
  "red_team",
  "manual_review",
  "stop",
]);

export const NodeContractSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  contextInputs: z.array(z.string().min(1).max(96)).max(32),
  outputKeys: z.array(z.string().min(1).max(96)).min(1).max(32),
  artifactMediaTypes: z.array(z.string().min(1).max(120)).max(12),
  milestone: z.string().min(1).max(240),
  acceptanceCriteria: z.array(z.string().min(1).max(240)).min(1).max(12),
  budgetAtomic: z.string().regex(/^[0-9]+$/u),
  permissions: z.array(NodePermissionSchema).max(8),
  timeoutSeconds: z.number().int().min(1).max(3600),
  failureRoute: NodeFailureRouteSchema,
});

export const QueenMutationNameSchema = z.enum([
  "ProposeTaskGraph",
  "AmendTaskGraph",
  "RankNodeAgents",
  "SelectNodeAgent",
  "AcceptNodeAssignment",
  "ConfirmTaskGraph",
  "StartTaskRun",
  "SubmitNodeOutput",
  "JudgeNodeOutput",
  "RequestAdversarialReview",
  "RepairNode",
  "FinalArbitrate",
  "WriteLearningLoop",
]);

export const TaskNodeSchema = z.strictObject({
  nodeId: z.string().min(1).max(96),
  type: TaskNodeTypeSchema,
  title: z.string().min(1).max(160),
  dependencies: z.array(z.string().min(1).max(96)).max(24).default([]),
  required: z.boolean().default(true),
  judgesNodeId: z.string().min(1).max(96).optional(),
  repairsNodeId: z.string().min(1).max(96).optional(),
  assignedAgentId: z.string().min(1).max(160).optional(),
  contract: NodeContractSchema.default({
    schemaVersion: "1",
    contextInputs: [],
    outputKeys: ["result"],
    artifactMediaTypes: [],
    milestone: "Complete the node contract",
    acceptanceCriteria: ["Output satisfies the declared schema"],
    budgetAtomic: "0",
    permissions: ["read_context", "write_artifact"],
    timeoutSeconds: 300,
    failureRoute: "stop",
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const TaskEdgeSchema = z.strictObject({
  from: z.string().min(1).max(96),
  to: z.string().min(1).max(96),
  condition: z.enum(["always", "approved", "needs_revision", "rejected"]).optional(),
});

export const RescuePolicySchema = z.strictObject({
  mode: z.enum(["auto"]),
  visibleToUser: z.literal(false),
  evidenceVisible: z.literal(true),
});

export const TaskGraphSchema = z.strictObject({
  taskId: z.string().uuid(),
  graphRevision: z.number().int().positive(),
  requiredStages: z.array(WorkflowStageSchema).min(RequiredWorkflowStages.length).max(RequiredWorkflowStages.length),
  riskLevel: RiskLevelSchema,
  startPolicy: StartPolicySchema,
  nodes: z.array(TaskNodeSchema).min(2).max(64),
  edges: z.array(TaskEdgeSchema).max(128),
  rescuePolicy: RescuePolicySchema,
}).superRefine((graph, ctx) => {
  const stages = new Set(graph.requiredStages);
  for (const stage of RequiredWorkflowStages) {
    if (!stages.has(stage)) {
      ctx.addIssue({ code: "custom", message: `Missing required workflow stage: ${stage}` });
    }
  }

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.nodeId)) {
      ctx.addIssue({ code: "custom", message: `Duplicate node id: ${node.nodeId}` });
    }
    nodeIds.add(node.nodeId);
  }

  if (!graph.nodes.some((node) => node.type === "plan")) {
    ctx.addIssue({ code: "custom", message: "Task graph must include a plan node" });
  }
  if (!graph.nodes.some((node) => node.type === "deliver")) {
    ctx.addIssue({ code: "custom", message: "Task graph must include a deliver node" });
  }

  for (const node of graph.nodes) {
    for (const dependency of node.dependencies) {
      if (!nodeIds.has(dependency)) {
        ctx.addIssue({ code: "custom", message: `Unknown dependency node: ${dependency}` });
      }
    }
    if (node.judgesNodeId !== undefined && !nodeIds.has(node.judgesNodeId)) {
      ctx.addIssue({ code: "custom", message: `Unknown judged node: ${node.judgesNodeId}` });
    }
    if (node.repairsNodeId !== undefined && !nodeIds.has(node.repairsNodeId)) {
      ctx.addIssue({ code: "custom", message: `Unknown repaired node: ${node.repairsNodeId}` });
    }
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from)) {
      ctx.addIssue({ code: "custom", message: `Unknown edge source: ${edge.from}` });
    }
    if (!nodeIds.has(edge.to)) {
      ctx.addIssue({ code: "custom", message: `Unknown edge target: ${edge.to}` });
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const nodeId of nodeIds) adjacency.set(nodeId, []);
  for (const edge of graph.edges) adjacency.get(edge.from)?.push(edge.to);
  for (const node of graph.nodes) {
    for (const dependency of node.dependencies) adjacency.get(dependency)?.push(node.nodeId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  if ([...nodeIds].some(visit)) {
    ctx.addIssue({ code: "custom", message: "Task graph must be acyclic" });
  }
});

const AgentScoreEventSchema = z.strictObject({
  score: z.number().min(0).max(1),
  occurredAt: z.string().datetime(),
});

export const AgentCandidateSchema = z.strictObject({
  agentId: z.string().min(1).max(160),
  displayName: z.string().min(1).max(160),
  capabilities: z.array(z.string().min(1).max(80)).min(1).max(24),
  categories: z.array(z.string().min(1).max(80)).max(16).optional(),
  tags: z.array(z.string().min(1).max(80)).max(32).default([]),
  license: z.string().min(1).max(160).optional(),
  provider: z.enum(["ollama", "deepseek", "kimi", "qwen", "zhipu", "codex", "custom"]),
  ownership: z.enum(["owner-trained", "third-party/local-served", "third-party/provider-api", "local-private"]),
  selectableBy: z.enum(["owner-only", "assigned-task", "public-market"]).default("public-market"),
  status: z.enum(["online", "offline", "degraded"]),
  costPer1kTokensUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative().optional(),
  qualityScore: z.number().min(0).max(1),
  scoreEvents: z.array(AgentScoreEventSchema).max(100).optional(),
  firstSeenAt: z.string().datetime().optional(),
  modelTag: z.string().min(1).max(160),
  modelDigest: z.union([z.string().regex(/^[0-9a-f]{64}$/), z.literal("provider-managed"), z.literal("local-private")]),
  riskCodes: z.array(z.string().min(1).max(80)).max(24).default([]),
});

export const NodeAssignmentSchema = z.strictObject({
  nodeId: z.string().min(1).max(96),
  selectedAgentId: z.string().min(1).max(160),
  status: AssignmentStatusSchema,
  selectedBy: z.enum(["queen", "user", "router"]),
  acceptedAt: z.string().datetime().optional(),
  override: z.boolean().default(false),
  overrideReason: z.string().min(1).max(240).optional(),
  riskNoticeAccepted: z.boolean().optional(),
  riskCodes: z.array(z.string().min(1).max(80)).max(24).default([]),
});

const ApprovalDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const QueenPlanningApprovalPayloadSchema = z.strictObject({
  version: z.literal("queen-planning-approval.v1"),
  action: z.literal("approve"),
  requestId: z.string().uuid(),
  taskId: z.string().uuid(),
  taskVersion: z.number().int().positive(),
  graphRevision: z.number().int().positive(),
  taskFingerprint: ApprovalDigestSchema,
  graphHash: ApprovalDigestSchema,
  assignmentHash: ApprovalDigestSchema,
  approved: z.boolean(),
});

const SnapshotAssignmentsSchema = z.array(z.tuple([z.string().min(1), NodeAssignmentSchema]));

function canonicalizeApprovalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeApprovalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeApprovalValue(item)]));
  }
  return value;
}

export function canonicalQueenPlanningApprovalBinding(input: {
  graph: unknown;
  assignments: unknown;
  approvedRevision: number;
  allowSystemAppended: boolean;
}): { graph: unknown; assignments: unknown } {
  if (!Number.isSafeInteger(input.approvedRevision) || input.approvedRevision < 1) {
    throw new Error("QUEEN_APPROVAL_REVISION_INVALID");
  }
  const graph = TaskGraphSchema.parse(input.graph);
  const assignments = SnapshotAssignmentsSchema.parse(input.assignments);
  const systemNodes = graph.nodes.filter((node) => node.metadata?.systemAppended === true);
  if (graph.graphRevision < input.approvedRevision
      || (!input.allowSystemAppended && (graph.graphRevision !== input.approvedRevision || systemNodes.length > 0))
      || (input.allowSystemAppended && graph.graphRevision - input.approvedRevision !== systemNodes.length)) {
    throw new Error("QUEEN_APPROVAL_GRAPH_INCREMENT_INVALID");
  }

  const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
  for (const node of systemNodes) {
    const attempt = node.metadata?.attempt;
    const parentNodeId = node.dependencies[0];
    const matchingEdges = graph.edges.filter((edge) => edge.to === node.nodeId);
    if ((node.type !== "repair" && node.type !== "red_team")
        || node.dependencies.length !== 1 || parentNodeId === undefined
        || !Number.isSafeInteger(attempt) || Number(attempt) < 1
        || matchingEdges.length !== 1 || matchingEdges[0]?.from !== parentNodeId
        || matchingEdges[0]?.condition !== "needs_revision"
        || (node.type === "repair" && node.repairsNodeId !== parentNodeId)) {
      throw new Error("QUEEN_APPROVAL_SYSTEM_INCREMENT_INVALID");
    }
  }
  if (graph.edges.some((edge) => {
    const fromSystem = systemNodes.some((node) => node.nodeId === edge.from);
    const toSystem = systemNodes.some((node) => node.nodeId === edge.to);
    return fromSystem || (toSystem && !systemNodes.some((node) =>
      node.nodeId === edge.to && node.dependencies[0] === edge.from));
  })) {
    throw new Error("QUEEN_APPROVAL_SYSTEM_EDGE_INVALID");
  }

  const assignmentMap = new Map<string, z.infer<typeof NodeAssignmentSchema>>();
  for (const [nodeId, assignment] of assignments) {
    if (assignmentMap.has(nodeId) || assignment.nodeId !== nodeId || !nodeIds.has(nodeId)) {
      throw new Error("QUEEN_APPROVAL_ASSIGNMENT_INVALID");
    }
    assignmentMap.set(nodeId, assignment);
  }
  for (const node of graph.nodes.filter((item) => item.required)) {
    if (assignmentMap.get(node.nodeId)?.status !== "accepted") {
      throw new Error("QUEEN_APPROVAL_REQUIRED_ASSIGNMENT_MISSING");
    }
  }

  const baseNodes = graph.nodes.filter((node) => node.metadata?.systemAppended !== true);
  const baseNodeIds = new Set(baseNodes.map((node) => node.nodeId));
  const baseEdges = graph.edges.filter((edge) => baseNodeIds.has(edge.from) && baseNodeIds.has(edge.to));
  const baseAssignments = assignments
    .filter(([nodeId]) => baseNodeIds.has(nodeId))
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    graph: canonicalizeApprovalValue({
      ...graph,
      graphRevision: input.approvedRevision,
      nodes: baseNodes,
      edges: baseEdges,
    }),
    assignments: canonicalizeApprovalValue(baseAssignments),
  };
}

export const QueenWorkflowEventSchema = z.strictObject({
  eventId: z.string().uuid(),
  taskId: z.string().uuid(),
  graphRevision: z.number().int().positive(),
  eventType: z.enum([
    "graph_proposed",
    "graph_amended",
    "agents_ranked",
    "agent_selected",
    "assignment_accepted",
    "graph_confirmed",
    "run_started",
    "node_submitted",
    "node_judged",
    "red_team_requested",
    "node_repaired",
    "final_arbitrated",
    "learning_loop_written",
  ]),
  actorAgentId: z.string().min(1).max(160),
  createdAt: z.string().datetime(),
  summary: z.string().min(1).max(500),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const QueenGraphqlRequestSchema = z.strictObject({
  query: z.string().min(1).max(20000),
  operationName: QueenMutationNameSchema.optional(),
  variables: z.strictObject({
    input: z.record(z.string(), z.unknown()),
  }),
});

export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;
export type TaskNodeType = z.infer<typeof TaskNodeTypeSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type StartPolicy = z.infer<typeof StartPolicySchema>;
export type AssignmentStatus = z.infer<typeof AssignmentStatusSchema>;
export type NodePermission = z.infer<typeof NodePermissionSchema>;
export type NodeFailureRoute = z.infer<typeof NodeFailureRouteSchema>;
export type NodeContract = z.infer<typeof NodeContractSchema>;
export type QueenMutationName = z.infer<typeof QueenMutationNameSchema>;
export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type TaskEdge = z.infer<typeof TaskEdgeSchema>;
export type RescuePolicy = z.infer<typeof RescuePolicySchema>;
export type TaskGraph = z.infer<typeof TaskGraphSchema>;
export type AgentCandidate = z.infer<typeof AgentCandidateSchema>;
export type NodeAssignment = z.infer<typeof NodeAssignmentSchema>;
export type QueenPlanningApprovalPayload = z.infer<typeof QueenPlanningApprovalPayloadSchema>;
export type QueenWorkflowEvent = z.infer<typeof QueenWorkflowEventSchema>;
export type QueenGraphqlRequest = z.infer<typeof QueenGraphqlRequestSchema>;
