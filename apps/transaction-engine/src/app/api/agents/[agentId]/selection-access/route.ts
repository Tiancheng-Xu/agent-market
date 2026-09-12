import { handleMatching } from "../../../../../matching/http";
export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  return handleMatching(request,(await context.params).agentId,"agent");
}
