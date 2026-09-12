import { handleGovernance } from "../../../../governance/http";
export const runtime = "nodejs";
export function GET(request: Request) { return handleGovernance(request, "reviews"); }
export function POST(request: Request) { return handleGovernance(request, "reviews"); }
