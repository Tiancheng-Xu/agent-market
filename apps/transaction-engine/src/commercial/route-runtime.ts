import { getAuthOrigin, getAuthService } from '../auth/runtime';
import { resolveRequestId } from '../lib/request-context';
import { createCommercialHandler } from './http';
import { getCommercialService } from './runtime';
export async function handleCommercialRequest(request: Request, orderId?: string): Promise<Response> {
  try { return await createCommercialHandler({ service: getCommercialService(), auth: getAuthService(), authOrigin: getAuthOrigin() })(request, orderId); }
  catch (error) {
    const requestId = resolveRequestId(request.headers);
    return Response.json({ error: error instanceof Error && /^RISK_ASSET_CONFIG_[A-Z_]+$/u.test(error.message) ? error.message : 'COMMERCIAL_UNAVAILABLE', requestId }, { status: 503, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } });
  }
}
