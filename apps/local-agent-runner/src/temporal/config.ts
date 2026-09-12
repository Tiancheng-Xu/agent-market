export function temporalConfig(env: Record<string, string | undefined>) {
  if (env.QUEEN_TEMPORAL_ENABLED !== "true") return undefined;
  const address = env.QUEEN_TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  // This delivery is local/non-AWS only. Remote credentials are intentionally unsupported.
  if (!/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/u.test(address)
      || Number(address.split(":")[1]) < 1 || Number(address.split(":")[1]) > 65535) {
    throw new Error("TEMPORAL_LOCAL_ADDRESS_REQUIRED");
  }
  const namespace = env.QUEEN_TEMPORAL_NAMESPACE ?? "default";
  const taskQueue = env.QUEEN_TEMPORAL_TASK_QUEUE ?? "queen-order-schedule-v1";
  if (![namespace, taskQueue].every(value => /^[a-zA-Z0-9_-]{1,128}$/u.test(value))) {
    throw new Error("TEMPORAL_CONFIG_INVALID");
  }
  return { address, namespace, taskQueue };
}
