export type OpsComponentStatus = "ok" | "degraded" | "unavailable";

export interface OpsHealthSnapshot {
  mode: "read_only";
  status: OpsComponentStatus;
  checkedAt: string;
  components: ReadonlyArray<{ name: string; status: OpsComponentStatus }>;
  mutations: readonly [];
}

export interface OpsHealthProbe {
  name: string;
  check(): Promise<OpsComponentStatus>;
}

export async function readOpsHealth(
  probes: readonly OpsHealthProbe[],
  now: () => Date = () => new Date(),
): Promise<OpsHealthSnapshot> {
  const components = await Promise.all(probes.map(async (probe) => {
    try {
      return { name: probe.name.replace(/[^a-z0-9_-]/giu, "-").slice(0, 48), status: await probe.check() };
    } catch {
      return { name: probe.name.replace(/[^a-z0-9_-]/giu, "-").slice(0, 48), status: "unavailable" as const };
    }
  }));
  const status = components.some((item) => item.status === "unavailable")
    ? "unavailable"
    : components.some((item) => item.status === "degraded") ? "degraded" : "ok";
  return { mode: "read_only", status, checkedAt: now().toISOString(), components, mutations: [] };
}
