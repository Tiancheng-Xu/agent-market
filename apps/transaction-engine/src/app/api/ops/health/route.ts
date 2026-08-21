import { readOpsHealth, type OpsHealthProbe } from "../../../../ops/health";
import { resolveRequestId } from "../../../../lib/request-context";

export function createOpsHealthHandler(probes: readonly OpsHealthProbe[]) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    const health = await readOpsHealth(probes);
    return Response.json({ ...health, requestId }, {
      status: health.status === "unavailable" ? 503 : 200,
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  };
}

export const GET = createOpsHealthHandler([
  { name: "transaction-api", async check() { return "ok"; } },
  { name: "database-config", async check() { return process.env.DATABASE_URL ? "ok" : "unavailable"; } },
  { name: "sepolia-rpc-config", async check() { return process.env.SEPOLIA_RPC_URL ? "ok" : "unavailable"; } },
]);
