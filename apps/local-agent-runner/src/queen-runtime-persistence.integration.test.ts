import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { expect, it } from "vitest";
import { createQueenOrchestrator } from "./queen-orchestrator";
import { openQueenRuntimePersistence } from "./queen-runtime-persistence";
import { queenEventOperationKey, type QueenWorkflowEvent } from "./queen-workflow-event";
import { publishQueenOutbox } from "./queen-outbox-publisher";

const databaseUrl = process.env.QUEEN_CHECKPOINT_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("isolates real PostgreSQL scopes, enforces role permissions and rejects stale writes", async () => {
  const url = new URL(databaseUrl!);
  if (url.hostname !== "127.0.0.1" || !/^\/agent_market_checkpoint_test_[a-z0-9_]+$/u.test(url.pathname)) {
    throw new Error("EPHEMERAL_LOCAL_DATABASE_REQUIRED");
  }
  const admin = postgres(url.toString(), { max: 1 });
  let persistence: Awaited<ReturnType<typeof openQueenRuntimePersistence>>;
  let publicSql: ReturnType<typeof postgres> | undefined;
  try {
    await admin.unsafe(await readFile(new URL("../../../database/queen-runtime-scopes.sql", import.meta.url), "utf8"));
    await admin.unsafe(`
      CREATE ROLE queen_probe_public LOGIN;
      CREATE ROLE queen_probe_owner LOGIN;
      GRANT USAGE ON SCHEMA queen_runtime_public TO queen_probe_public;
      GRANT SELECT, INSERT, UPDATE ON queen_runtime_public.queen_workflows TO queen_probe_public;
      GRANT SELECT, INSERT, UPDATE ON queen_runtime_public.queen_outbox TO queen_probe_public;
      GRANT USAGE ON SCHEMA queen_runtime_owner TO queen_probe_owner;
      GRANT SELECT, INSERT, UPDATE ON queen_runtime_owner.queen_workflows TO queen_probe_owner;
    `);
    const publicUrl = new URL(url); publicUrl.username = "queen_probe_public";
    const ownerUrl = new URL(url); ownerUrl.username = "queen_probe_owner";
    persistence = await openQueenRuntimePersistence({
      QUEEN_PUBLIC_DATABASE_URL: publicUrl.toString(), QUEEN_OWNER_DATABASE_URL: ownerUrl.toString(),
    });
    expect(persistence).toBeDefined();
    const stores = persistence!.stores;
    const taskId = "01900000-0000-7000-8000-000000000012";
    const propose = async (scope: "public" | "owner", requirement: string) => {
      const orchestrator = createQueenOrchestrator({ agents: [], queenAgentId: "queen-test", workflowStore: stores[scope] });
      const response = await orchestrator.handleGraphql({
        operationName: "ProposeTaskGraph", query: "mutation ProposeTaskGraph { proposeTaskGraph }",
        variables: { input: { taskId, requirement } },
      });
      expect(response.errors).toBeUndefined();
      expect(response.data).not.toBeNull();
    };
    await propose("public", "Public test task");
    expect(await stores.owner.load(taskId)).toBeNull();
    await propose("owner", "Owner private test task");
    expect((await stores.public.load(taskId))?.requirement).toBe("Public test task");
    expect((await stores.owner.load(taskId))?.requirement).toBe("Owner private test task");
    const first = (await stores.public.load(taskId))!;
    const next = { ...first, recordVersion: first.recordVersion + 1 };
    await stores.public.save(next, first.recordVersion);
    await expect(stores.public.save(next, first.recordVersion)).rejects.toThrow("QUEEN_WORKFLOW_VERSION_CONFLICT");
    const event: QueenWorkflowEvent = {
      schemaVersion: "queen-workflow-event.v1", eventId: "01900000-0000-7000-8000-000000000044",
      eventType: "task.requested", taskId, scopeId: "01900000-0000-7000-8000-000000000045",
      graphRevision: first.graph.graphRevision, taskFingerprint: `sha256:${"a".repeat(64)}`,
      payloadRef: "01900000-0000-7000-8000-000000000046", payloadHash: `sha256:${"b".repeat(64)}`,
      operationKey: "", occurredAt: "2026-09-04T00:00:00Z", expiresAt: "2026-09-05T00:00:00Z",
    };
    event.operationKey = queenEventOperationKey(event);
    await expect(stores.public.save(next, first.recordVersion, event)).rejects.toThrow("QUEEN_WORKFLOW_VERSION_CONFLICT");
    expect((await admin`SELECT event_id FROM queen_runtime_public.queen_outbox`).count).toBe(0);
    await stores.public.save({ ...next, recordVersion: next.recordVersion + 1 }, next.recordVersion, event);
    expect((await admin`SELECT event_id FROM queen_runtime_public.queen_outbox`).count).toBe(1);
    await expect(publishQueenOutbox(admin, "queen_runtime_public", async () => {
      throw new Error("PUBLISH_FAILED");
    })).rejects.toThrow("PUBLISH_FAILED");
    expect((await admin`SELECT status FROM queen_runtime_public.queen_outbox`)[0]?.status).toBe("pending");
    const delivered: string[] = [];
    expect(await publishQueenOutbox(admin, "queen_runtime_public", async published => {
      delivered.push(published.eventId);
      return { messageId: "local-test-receipt" };
    })).toBe(1);
    expect(await publishQueenOutbox(admin, "queen_runtime_public", async () => {
      throw new Error("SHOULD_NOT_REPUBLISH");
    })).toBe(0);
    expect(delivered).toEqual([event.eventId]);
    expect((await admin`SELECT status FROM queen_runtime_public.queen_outbox`)[0]?.status).toBe("published");
    publicSql = postgres(publicUrl.toString(), { max: 1 });
    await expect(publicSql`SELECT snapshot FROM queen_runtime_owner.queen_workflows`).rejects.toMatchObject({ code: "42501" });
  } finally {
    await persistence?.close();
    await publicSql?.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  }
}, 30000);
