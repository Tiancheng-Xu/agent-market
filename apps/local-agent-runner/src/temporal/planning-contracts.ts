import { z } from "zod";

// Workflow-safe: no Node/SQL/StateGraph runtime imports.
export const TemporalPlanningReferenceSchema = z.object({
  requestId: z.string().uuid(), taskId: z.string().uuid(), scopeId: z.string().uuid(),
}).strict();
export type TemporalPlanningReference = z.infer<typeof TemporalPlanningReferenceSchema>;
export interface TemporalPlanningResult {
  outcome: "committed" | "duplicate-committed" | "rejected" | "busy" | "uncertain";
}
export interface TemporalPlanningActivities {
  consumePlanning(reference: TemporalPlanningReference): Promise<TemporalPlanningResult>;
}
