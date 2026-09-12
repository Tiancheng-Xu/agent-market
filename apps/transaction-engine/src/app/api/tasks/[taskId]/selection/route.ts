import { handleMatching } from "../../../../../matching/http";
export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return handleMatching(request,(await context.params).taskId,"task");
}
export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return handleMatching(request,(await context.params).taskId,"task");
}
