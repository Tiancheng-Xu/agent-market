import { z } from "zod";
import { createQueenDurablePlanning } from "../queen-durable-planning";
import { createQueenPlanningAuthorization } from "../queen-planning-authorization";
import type { QueenOperationLedger } from "../queen-operation-ledger";
import { QueenWorkflowEventSchema, queenEventOperationKey } from "../queen-workflow-event";

const Reference = z.object({
  requestId: z.string().uuid(), taskId: z.string().uuid(), scopeId: z.string().uuid(),
}).strict();
const Batch = z.array(Reference).min(1).max(20);
export type PlanningReference = z.infer<typeof Reference>;
export type PlanningConsumption = PlanningReference & {
  outcome: "committed" | "duplicate-committed" | "busy" | "uncertain" | "rejected";
};
export type LocalPlanningOptions = Parameters<typeof createQueenDurablePlanning>[0] & {
  ledger: QueenOperationLedger;
};

/** Explicit local entry; safe to register consume as a Temporal Activity with
 * maximumAttempts: 1. Host owns the public ledger, SQL and PostgresSaver lifecycle.
 * References are selectors, not grants. Never expose this as an anonymous API.
 * No polling, transport acknowledgment, readiness mutation or startup migration.
 */
export function createLocalPlanningRuntime(
  env: Record<string, string | undefined>, options: LocalPlanningOptions,
) {
  if (env.QUEEN_LOCAL_PLANNING_ENABLED !== "true") return undefined;
  const authorize = createQueenPlanningAuthorization(options.authorizationSql);
  const plan = createQueenDurablePlanning(options);
  const resolve = async (reference: PlanningReference) => {
    const [row] = await options.authorizationSql`
      SELECT event FROM agent_market.queen_planning_requests
      WHERE id = ${reference.requestId} AND task_id = ${reference.taskId}
    `;
    const event = QueenWorkflowEventSchema.parse(row?.event);
    if (event.eventType !== "task.requested" || event.payloadRef !== reference.requestId
        || event.taskId !== reference.taskId || event.scopeId !== reference.scopeId
        || event.operationKey !== queenEventOperationKey(event)
        || Date.parse(event.expiresAt) <= Date.now()
        || Date.parse(event.occurredAt) > Date.now() + 60000) {
      throw new Error("QUEEN_LOCAL_PLANNING_REFERENCE_REJECTED");
    }
    await authorize(event);
    return event;
  };
  const consume = async (input: PlanningReference): Promise<PlanningConsumption> => {
    const reference = Reference.parse(input);
    let event;
    try {
      event = await resolve(reference);
    } catch {
      // Denied/missing/expired/unavailable authorization never claims an operation.
      // Keep payloads, SQL diagnostics and credentials out of transport results.
      return { ...reference, outcome: "rejected" };
    }
    try {
      const outcome = await options.ledger.execute(event, async () => {
        const current = await resolve(reference);
        if (current.operationKey !== event.operationKey || current.payloadHash !== event.payloadHash) {
          throw new Error("QUEEN_LOCAL_PLANNING_IDENTITY_CHANGED");
        }
        // Real StateGraph/Checkpoint persistence and per-node reauthorization.
        await plan(current);
      });
      return { ...reference, outcome };
    } catch {
      // A ledger/storage error can occur after a claim or a completed plan.
      // Never turn a transport error into permission to repeat an unknown effect.
      return { ...reference, outcome: "uncertain" };
    }
  };
  return {
    consume,
    async consumeBatch(input: PlanningReference[]): Promise<PlanningConsumption[]> {
      // Validate the entire batch before the first operation; bounded and serial.
      const references = Batch.parse(input);
      const results: PlanningConsumption[] = [];
      for (const reference of references) results.push(await consume(reference));
      return results;
    },
  };
}
