import type { VrfBindingRecord, VrfBindingStore } from "./vrf-selection-binding";

/** Adapt the existing SQL client at the composition root; no shared schema or client changes. */
export interface VrfSqlClient {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export class SqlVrfBindingStore implements VrfBindingStore {
  constructor(private readonly db: VrfSqlClient) {}
  /** Explicit opt-in. Executed only in local PGlite tests in this delivery. */
  async initialize(): Promise<void> {
    await this.db.query(`CREATE TABLE IF NOT EXISTS public.vrf_exploration_bindings (
      task_key text PRIMARY KEY,
      version integer NOT NULL CHECK (version > 0),
      value jsonb NOT NULL,
      request_key text UNIQUE
    )`);
    await this.db.query(`CREATE UNIQUE INDEX IF NOT EXISTS vrf_binding_task_identity
      ON public.vrf_exploration_bindings ((value #>> '{binding,namespace}'),(value #>> '{binding,taskId}'))`);
  }
  async insert(record: VrfBindingRecord): Promise<boolean> {
    const result = await this.db.query<{ task_key: string }>(
      `INSERT INTO public.vrf_exploration_bindings (task_key, version, value)
       VALUES ($1, 1, $2::jsonb) ON CONFLICT (task_key) DO NOTHING RETURNING task_key`,
      [record.binding.taskKey, JSON.stringify(record)],
    );
    return result.rows.length === 1;
  }
  async read(taskKey: string): Promise<{ version: number; record: VrfBindingRecord } | null> {
    const result = await this.db.query<{ version: number; value: VrfBindingRecord }>(
      "SELECT version, value FROM public.vrf_exploration_bindings WHERE task_key = $1", [taskKey],
    );
    const row = result.rows[0];
    return row ? { version: row.version, record: row.value } : null;
  }
  async compareAndSet(taskKey: string, expectedVersion: number, record: VrfBindingRecord): Promise<boolean> {
    const requestKey = record.requestId === null ? null
      : `${record.binding.chainId}:${record.binding.selectorAddress}:${record.requestId}`;
    const result = await this.db.query<{ task_key: string }>(
      `UPDATE public.vrf_exploration_bindings SET value = $3::jsonb, version = version + 1, request_key = $4
       WHERE task_key = $1 AND version = $2 RETURNING task_key`,
      [taskKey, expectedVersion, JSON.stringify(record), requestKey],
    );
    return result.rows.length === 1;
  }
}
