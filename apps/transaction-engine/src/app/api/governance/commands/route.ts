import { handleGovernance } from "../../../../governance/http";
export const runtime = "nodejs";
export function POST(request: Request) { return handleGovernance(request, "commands"); }
