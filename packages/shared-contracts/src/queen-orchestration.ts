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

export const QueenMutationNameSchema = z.enum([
  "ProposeTaskGraph",
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
});

export const AgentCandidateSchema = z.strictObject({
  agentId: z.string().min(1).max(160),
  displayName: z.string().min(1).max(160),
  capabilities: z.array(z.string().min(1).max(80)).min(1).max(24),
  tags: z.array(z.string().min(1).max(80)).max(32).default([]),
  license: z.string().min(1).max(160).optional(),
  provider: z.enum(["ollama", "deepseek", "kimi", "qwen", "zhipu", "codex", "custom"]),
  ownership: z.enum(["owner-trained", "third-party/local-served", "third-party/provider-api", "local-private"]),
  selectableBy: z.enum(["owner-only", "assigned-task", "public-market"]).default("public-market"),
  status: z.enum(["online", "offline", "degraded"]),
  costPer1kTokensUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative().optional(),
  qualityScore: z.number().min(0).max(1),
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

export const QueenWorkflowEventSchema = z.strictObject({
  eventId: z.string().uuid(),
  taskId: z.string().uuid(),
  graphRevision: z.number().int().positive(),
  eventType: z.enum([
    "graph_proposed",
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
export type QueenMutationName = z.infer<typeof QueenMutationNameSchema>;
export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type TaskEdge = z.infer<typeof TaskEdgeSchema>;
export type RescuePolicy = z.infer<typeof RescuePolicySchema>;
export type TaskGraph = z.infer<typeof TaskGraphSchema>;
export type AgentCandidate = z.infer<typeof AgentCandidateSchema>;
export type NodeAssignment = z.infer<typeof NodeAssignmentSchema>;
export type QueenWorkflowEvent = z.infer<typeof QueenWorkflowEventSchema>;
export type QueenGraphqlRequest = z.infer<typeof QueenGraphqlRequestSchema>;
