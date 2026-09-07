import { PostgresQueenWorkflowStore } from "./queen-workflow-store";

export async function openQueenRuntimePersistence(env: Record<string, string | undefined>) {
  const publicUrl = env.QUEEN_PUBLIC_DATABASE_URL;
  const ownerUrl = env.QUEEN_OWNER_DATABASE_URL;
  if (publicUrl === undefined && ownerUrl === undefined) return undefined;
  if (!publicUrl || !ownerUrl) throw new Error("QUEEN_PERSISTENCE_CONFIG_INCOMPLETE");
  const stores = {
    public: PostgresQueenWorkflowStore.connect(publicUrl, "queen_runtime_public"),
    owner: PostgresQueenWorkflowStore.connect(ownerUrl, "queen_runtime_owner"),
  };
  const close = async () => {
    await Promise.all([stores.public.close(), stores.owner.close()]);
  };
  try {
    await Promise.all([stores.public.assertReady(), stores.owner.assertReady()]);
  } catch {
    await close().catch(() => undefined);
    // Never expose database connection strings or driver diagnostics through startup errors.
    throw new Error("QUEEN_PERSISTENCE_NOT_READY");
  }
  return { stores, close };
}
