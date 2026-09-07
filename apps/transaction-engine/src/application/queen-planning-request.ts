import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { validate as isUuid } from "uuid";

export class QueenPlanningError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}

const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

// Only the authenticated HTTP adapter supplies actorWallet. A queue scope is NOT
// a wallet credential. This record grants planning, never execution or payment.
export async function requestQueenPlanning(sql: Sql, input: {
  taskId: string; actorWallet: string; expectedTaskVersion: number;
}) {
  if (!isUuid(input.taskId) || !/^0x[0-9a-f]{40}$/iu.test(input.actorWallet)
      || !Number.isSafeInteger(input.expectedTaskVersion) || input.expectedTaskVersion < 1) {
    throw new QueenPlanningError("QUEEN_PLANNING_INPUT_INVALID", 400);
  }
  const wallet = input.actorWallet.toLowerCase();
  return sql.begin(async tx => {
    const [task] = await tx`
      SELECT id, publisher_wallet, version, status, title, description, requirements,
        budget_atomic::text AS budget_atomic
      FROM agent_market.tasks WHERE id = ${input.taskId} FOR UPDATE
    `;
    // Do not disclose task existence to another wallet.
    if (!task || String(task.publisher_wallet).toLowerCase() !== wallet) {
      throw new QueenPlanningError("QUEEN_TASK_UNAVAILABLE", 404);
    }
    if (task.version !== input.expectedTaskVersion || task.status !== "open") {
      throw new QueenPlanningError("QUEEN_TASK_VERSION_OR_STATE_CONFLICT", 409);
    }
    const [existing] = await tx`
      SELECT id, status, expires_at > clock_timestamp() AS valid
      FROM agent_market.queen_planning_requests
      WHERE task_id = ${input.taskId} AND task_version = ${input.expectedTaskVersion}
    `;
    if (existing) {
      if (existing.status !== "requested" || !existing.valid) {
        throw new QueenPlanningError("QUEEN_PLANNING_RECONCILIATION_REQUIRED", 409);
      }
      return { requestId: String(existing.id), status: "queued" as const, duplicate: true };
    }
    const id = randomUUID();
    const scopeId = randomUUID();
    const payload = {
      version: "queen-planning-payload.v1", action: "plan",
      taskId: input.taskId, taskVersion: input.expectedTaskVersion,
      title: task.title, description: task.description, requirements: task.requirements,
      budgetAtomic: task.budget_atomic,
    };
    const payloadHash = digest(payload);
    // A planning snapshot identity, not a funding/risk quote fingerprint.
    const taskFingerprint = digest(["queen-planning-task.v1", payloadHash]);
    const [clock] = await tx`SELECT clock_timestamp() AS now`;
    const now = new Date(clock!.now as string | Date);
    const event = {
      schemaVersion: "queen-workflow-event.v1", eventId: randomUUID(),
      eventType: "task.requested", taskId: input.taskId, scopeId,
      graphRevision: 1, taskFingerprint, payloadRef: id, payloadHash,
      operationKey: digest([
        "queen-workflow-event.v1", "task.requested", scopeId, input.taskId,
        1, taskFingerprint, id, payloadHash,
      ]),
      occurredAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    };
    await tx`
      INSERT INTO agent_market.queen_planning_requests
        (id, task_id, task_version, publisher_wallet, payload, event, allowed_action, status, expires_at)
      VALUES (${id}, ${input.taskId}, ${input.expectedTaskVersion}, ${wallet},
        ${tx.json(payload)}, ${tx.json(event)}, 'plan', 'requested', ${event.expiresAt})
    `;
    await tx`
      INSERT INTO queen_runtime_public.queen_outbox (event_id, operation_key, event, status)
      VALUES (${event.eventId}, ${event.operationKey}, ${tx.json(event)}, 'pending')
    `;
    return { requestId: id, status: "queued" as const, duplicate: false };
  });
}
