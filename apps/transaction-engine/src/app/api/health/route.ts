import { resolveRequestId } from "../../../lib/request-context";

export async function GET(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request.headers);

  return Response.json(
    { status: "ok", service: "transaction-engine", requestId },
    {
      headers: {
        "cache-control": "no-store",
        "x-request-id": requestId,
      },
    },
  );
}
