import { createHash } from "node:crypto";
import { END, START, StateGraph, interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";
import { z } from "zod";

export const QueenTaskStateSchema = z.object({
  scopeId: z.string().min(1).max(160),
  taskId: z.string().uuid(),
  graphRevision: z.number().int().positive(),
  taskFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  riskLevel: z.enum(["low", "high"]).default("high"),
  redTeamDecision: z.enum(["pending", "approved", "needs_revision", "rejected"]).default("pending"),
  planRef: z.string().min(1).nullable().default(null),
  outputRef: z.string().min(1).nullable().default(null),
  finalRef: z.string().min(1).nullable().default(null),
  repairCount: z.number().int().min(0).max(2).default(0),
  decision: z.enum(["pending", "approved", "needs_revision", "rejected"]).default("pending"),
  status: z.enum(["planning", "awaiting_approval", "executing", "reviewing", "repairing", "completed", "rejected"]).default("planning"),
});

export type QueenTaskState = z.infer<typeof QueenTaskStateSchema>;
type Action = "plan" | "approve" | "execute" | "judge" | "red_team" | "repair" | "finalize";
const Reference = z.string().min(1).max(256);
const Decision = z.enum(["approved", "needs_revision", "rejected"]);
const Approval = z.object({
  approved: z.boolean(), graphRevision: z.number().int().positive(),
  taskFingerprint: z.string(),
}).strict();

export interface QueenTaskGraphPorts {
  // Must check current server-owned identity, assignment, revision and approval;
  // checkpoint data and resume payloads are not authorization credentials.
  authorize(state: QueenTaskState, action: Action): Promise<void>;
  plan(state: QueenTaskState, operationKey: string): Promise<string>;
  execute(state: QueenTaskState, operationKey: string): Promise<string>;
  judge(state: QueenTaskState, operationKey: string): Promise<z.infer<typeof Decision>>;
  redTeam?(state: QueenTaskState, operationKey: string): Promise<z.infer<typeof Decision>>;
  repair(state: QueenTaskState, operationKey: string): Promise<string>;
  finalize(state: QueenTaskState, operationKey: string): Promise<string>;
}

export function queenTaskThreadId(state: Pick<QueenTaskState, "scopeId" | "taskId" | "graphRevision" | "taskFingerprint">): string {
  return createHash("sha256").update(JSON.stringify([
    "queen-task-v1", state.scopeId, state.taskId, state.graphRevision, state.taskFingerprint,
  ])).digest("hex");
}

export function createQueenTaskGraph(ports: QueenTaskGraphPorts, checkpointer: BaseCheckpointSaver) {
  const key = (state: QueenTaskState, action: Action) =>
    `${queenTaskThreadId(state)}:${action}:${state.repairCount}`;
  // Ports must durably deduplicate operationKey before invoking external side effects.
  // A checkpointer alone cannot close the provider-success/checkpoint-write crash window.
  return new StateGraph(QueenTaskStateSchema)
    .addNode("queen", async (state) => {
      await ports.authorize(state, "plan");
      return { planRef: Reference.parse(await ports.plan(state, key(state, "plan"))), status: "awaiting_approval" as const };
    })
    .addNode("approval", async (state) => {
      const approval = Approval.parse(interrupt({
        reason: "GRAPH_APPROVAL_REQUIRED", taskId: state.taskId,
        graphRevision: state.graphRevision, taskFingerprint: state.taskFingerprint,
        planRef: state.planRef,
      }));
      if (approval.graphRevision !== state.graphRevision || approval.taskFingerprint !== state.taskFingerprint) {
        throw new Error("QUEEN_APPROVAL_VERSION_MISMATCH");
      }
      await ports.authorize(state, "approve");
      return { status: approval.approved ? "executing" as const : "rejected" as const };
    })
    .addNode("agent", async (state) => {
      await ports.authorize(state, "execute");
      return { outputRef: Reference.parse(await ports.execute(state, key(state, "execute"))), status: "reviewing" as const };
    })
    .addNode("judge", async (state) => {
      if (!state.outputRef) throw new Error("QUEEN_OUTPUT_REQUIRED");
      await ports.authorize(state, "judge");
      return { decision: Decision.parse(await ports.judge(state, key(state, "judge"))) };
    })
    .addNode("repair", async (state) => {
      if (state.decision !== "needs_revision" || state.repairCount >= 2) throw new Error("QUEEN_REPAIR_NOT_ALLOWED");
      await ports.authorize(state, "repair");
      return {
        outputRef: Reference.parse(await ports.repair(state, key(state, "repair"))),
        repairCount: state.repairCount + 1, decision: "pending" as const,
        redTeamDecision: "pending" as const, status: "reviewing" as const,
      };
    })
    .addNode("red_team", async (state) => {
      if (state.decision !== "approved") throw new Error("QUEEN_JUDGMENT_REQUIRED");
      await ports.authorize(state, "red_team");
      if (!ports.redTeam) throw new Error("QUEEN_RED_TEAM_UNAVAILABLE");
      const decision = Decision.parse(await ports.redTeam(state, key(state, "red_team")));
      return { redTeamDecision: decision, decision };
    })
    .addNode("final_arbiter", async (state) => {
      if (state.decision !== "approved") throw new Error("QUEEN_JUDGMENT_REQUIRED");
      if (state.riskLevel === "high" && state.redTeamDecision !== "approved") {
        throw new Error("QUEEN_RED_TEAM_REQUIRED");
      }
      await ports.authorize(state, "finalize");
      return { finalRef: Reference.parse(await ports.finalize(state, key(state, "finalize"))), status: "completed" as const };
    })
    .addNode("reject", () => ({ status: "rejected" as const }))
    .addEdge(START, "queen")
    .addEdge("queen", "approval")
    .addConditionalEdges("approval", (state) => state.status === "rejected" ? "reject" : "agent", { reject: "reject", agent: "agent" })
    .addEdge("agent", "judge")
    .addConditionalEdges("judge", (state) => state.decision === "approved" ? (state.riskLevel === "high" ? "red_team" : "final_arbiter")
      : state.decision === "needs_revision" && state.repairCount < 2 ? "repair" : "reject",
    { final_arbiter: "final_arbiter", red_team: "red_team", repair: "repair", reject: "reject" })
    .addConditionalEdges("red_team", (state) => state.redTeamDecision === "approved" ? "final_arbiter"
      : state.redTeamDecision === "needs_revision" && state.repairCount < 2 ? "repair" : "reject",
    { final_arbiter: "final_arbiter", repair: "repair", reject: "reject" })
    .addEdge("repair", "judge")
    .addEdge("final_arbiter", END)
    .addEdge("reject", END)
    .compile({ checkpointer });
}
