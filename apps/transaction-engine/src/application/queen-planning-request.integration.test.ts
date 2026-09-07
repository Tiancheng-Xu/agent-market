import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";
import { requestQueenPlanning } from "./queen-planning-request";

const databaseUrl = process.env.QUEEN_PLANNING_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("authorizes planning and atomically deduplicates or rolls back its outbox", async () => {
  const url = new URL(databaseUrl!);
  if (url.hostname !== "127.0.0.1" || !/^\/agent_market_planning_test_[a-z0-9_]+$/u.test(url.pathname)) {
    throw new Error("EPHEMERAL_LOCAL_DATABASE_REQUIRED");
  }
  const sql = postgres(url.toString(), { max: 4 });
  const migrationSql = postgres(url.toString(), { max: 1 });
  const owner = `0x${"a".repeat(40)}`;
  try {
    for (const file of ["migrations/0001_agent_market_core.sql", "queen-runtime-scopes.sql", "queen-planning-requests.sql"]) {
      await migrationSql.unsafe(await readFile(new URL(`../../../../database/${file}`, import.meta.url), "utf8"));
    }
    const taskId = randomUUID();
    const failedTaskId = randomUUID();
    for (const id of [taskId, failedTaskId]) {
      await sql`
        INSERT INTO agent_market.tasks
          (id, publisher_wallet, title, description, requirements, budget_atomic, request_id)
        VALUES (${id}, ${owner}, 'Planning test', 'Private requirement', ARRAY['Gate'], 100, ${randomUUID()})
      `;
    }
    const input = { taskId, actorWallet: owner, expectedTaskVersion: 1 };
    await expect(requestQueenPlanning(sql, { ...input, actorWallet: `0x${"b".repeat(40)}` }))
      .rejects.toThrow("QUEEN_TASK_UNAVAILABLE");
    await expect(requestQueenPlanning(sql, { ...input, expectedTaskVersion: 2 }))
      .rejects.toThrow("QUEEN_TASK_VERSION_OR_STATE_CONFLICT");
    const results = await Promise.all([requestQueenPlanning(sql, input), requestQueenPlanning(sql, input)]);
    expect(results[0]!.requestId).toBe(results[1]!.requestId);
    expect(results.filter(result => !result.duplicate)).toHaveLength(1);
    const requests = await sql`SELECT * FROM agent_market.queen_planning_requests`;
    const messages = await sql`SELECT * FROM queen_runtime_public.queen_outbox`;
    expect(requests).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(requests[0]!.allowed_action).toBe("plan");
    expect(messages[0]!.event.payloadRef).toBe(requests[0]!.id);
    expect(JSON.stringify(messages[0]!.event)).not.toContain("Private requirement");
    expect(JSON.stringify(messages[0]!.event)).not.toContain(owner);
    // Failure after the private request INSERT must roll back that INSERT too.
    await sql.unsafe(`ALTER TABLE queen_runtime_public.queen_outbox
      ADD CONSTRAINT reject_test_task CHECK ((event ->> 'taskId') <> '${failedTaskId}')`);
    await expect(requestQueenPlanning(sql, { ...input, taskId: failedTaskId })).rejects.toThrow();
    expect(await sql`SELECT id FROM agent_market.queen_planning_requests WHERE task_id = ${failedTaskId}`)
      .toHaveLength(0);
    expect(await sql`SELECT event_id FROM queen_runtime_public.queen_outbox`).toHaveLength(1);
    await sql`UPDATE agent_market.queen_planning_requests SET status = 'revoked' WHERE task_id = ${taskId}`;
    await expect(requestQueenPlanning(sql, input)).rejects.toThrow("QUEEN_PLANNING_RECONCILIATION_REQUIRED");
  } finally {
    await migrationSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  }
}, 30000);
