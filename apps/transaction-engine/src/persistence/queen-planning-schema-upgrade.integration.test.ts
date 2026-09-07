import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("upgrades a legacy queen planning requests table with validated approval constraints", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE SCHEMA agent_market;
      CREATE TABLE agent_market.queen_planning_requests (
        id uuid PRIMARY KEY,
        task_id uuid NOT NULL,
        task_version integer NOT NULL CHECK (task_version > 0),
        publisher_wallet text NOT NULL,
        payload jsonb NOT NULL,
        event jsonb NOT NULL,
        allowed_action text NOT NULL CHECK (allowed_action = 'plan'),
        status text NOT NULL CHECK (status IN ('requested', 'revoked')),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (task_id, task_version),
        CHECK ((event ->> 'payloadRef')::uuid = id),
        CHECK ((event ->> 'taskId')::uuid = task_id)
      );
      INSERT INTO agent_market.queen_planning_requests
        (id, task_id, task_version, publisher_wallet, payload, event, allowed_action, status, expires_at)
      VALUES
        (
          '01991ed0-0000-7000-8000-000000000001',
          '01991ed0-0000-7000-8000-000000000101',
          1,
          '0xlegacy',
          '{"legacy":true}',
          '{"payloadRef":"01991ed0-0000-7000-8000-000000000001","taskId":"01991ed0-0000-7000-8000-000000000101"}',
          'plan',
          'requested',
          clock_timestamp() + interval '5 minutes'
        ),
        (
          '01991ed0-0000-7000-8000-000000000002',
          '01991ed0-0000-7000-8000-000000000102',
          1,
          '0xlegacy',
          '{"legacy":true}',
          '{"payloadRef":"01991ed0-0000-7000-8000-000000000002","taskId":"01991ed0-0000-7000-8000-000000000102"}',
          'plan',
          'requested',
          clock_timestamp() + interval '5 minutes'
        );
    `);

    await database.exec(await readFile(
      new URL("../../../../database/queen-planning-requests.sql", import.meta.url),
      "utf8",
    ));

    const columns = await database.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'agent_market'
        AND table_name = 'queen_planning_requests'
        AND column_name IN (
          'approval_id',
          'approval_decision',
          'approval_payload',
          'approval_event',
          'approval_expires_at'
        )
      ORDER BY column_name
    `);
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      "approval_decision",
      "approval_event",
      "approval_expires_at",
      "approval_id",
      "approval_payload",
    ]);

    const constraints = await database.query<{ conname: string; convalidated: boolean }>(`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conrelid = 'agent_market.queen_planning_requests'::regclass
        AND contype = 'c'
        AND conname IN (
          'queen_planning_event_payload_ref_matches',
          'queen_planning_event_task_matches',
          'queen_planning_approval_all_or_none',
          'queen_planning_approval_payload_ref_matches',
          'queen_planning_approval_task_matches'
        )
      ORDER BY conname
    `);
    expect(constraints.rows).toEqual([
      { conname: "queen_planning_approval_all_or_none", convalidated: true },
      { conname: "queen_planning_approval_payload_ref_matches", convalidated: true },
      { conname: "queen_planning_approval_task_matches", convalidated: true },
      { conname: "queen_planning_event_payload_ref_matches", convalidated: true },
      { conname: "queen_planning_event_task_matches", convalidated: true },
    ]);

    const indexes = await database.query<{ indexdef: string }>(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'agent_market'
        AND tablename = 'queen_planning_requests'
        AND indexname = 'uq_queen_planning_requests_approval_id'
    `);
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]!.indexdef).toContain("UNIQUE INDEX");
    expect(indexes.rows[0]!.indexdef).toContain("WHERE (approval_id IS NOT NULL)");

    await database.exec(`
      ALTER TABLE agent_market.queen_planning_requests
        DROP CONSTRAINT queen_planning_requests_approval_id_key;
      UPDATE agent_market.queen_planning_requests
      SET approval_id = '01991ed0-0000-7000-8000-000000000201',
          approval_decision = true,
          approval_payload = '{"approved":true}',
          approval_event = '{"payloadRef":"01991ed0-0000-7000-8000-000000000201","taskId":"01991ed0-0000-7000-8000-000000000101"}',
          approval_expires_at = clock_timestamp() + interval '5 minutes'
      WHERE id = '01991ed0-0000-7000-8000-000000000001';
    `);
    await expect(database.exec(`
      UPDATE agent_market.queen_planning_requests
      SET approval_id = '01991ed0-0000-7000-8000-000000000201',
          approval_decision = false,
          approval_payload = '{"approved":false}',
          approval_event = '{"payloadRef":"01991ed0-0000-7000-8000-000000000201","taskId":"01991ed0-0000-7000-8000-000000000102"}',
          approval_expires_at = clock_timestamp() + interval '5 minutes'
      WHERE id = '01991ed0-0000-7000-8000-000000000002';
    `)).rejects.toThrow(/uq_queen_planning_requests_approval_id/u);
  } finally {
    await database.close();
  }
}, 30_000);
