import { AuthError, readSessionCookie } from '../auth/session';
import { resolveRequestId } from '../lib/request-context';
import { CommercialError, type CommercialService } from './service';
export function createCommercialHandler(input: {
  service: CommercialService; authOrigin: URL;
  auth: { authenticateSession(token: string): Promise<{ walletAddress: string }> };
}) {
  return async (request: Request, orderId?: string): Promise<Response> => {
    const requestId = resolveRequestId(request.headers);
    const headers = { 'cache-control': 'no-store', 'x-request-id': requestId };
    try {
      if (request.method !== 'GET' && request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED', requestId }, { status: 405, headers });
      if (request.method === 'POST' && request.headers.get('origin') !== input.authOrigin.origin) throw new AuthError('AUTH_ORIGIN_MISMATCH', 403);
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError('AUTH_SESSION_INVALID');
      const session = await input.auth.authenticateSession(token);
      if (request.method === 'GET') {
        if (!orderId) throw new CommercialError('COMMERCIAL_ID_INVALID', 400);
        return Response.json({ ...await input.service.read(orderId, session.walletAddress), requestId }, { headers });
      }
      // Bound streamed bodies as well as Content-Length to avoid unbounded JSON allocations.
      const reader = request.body?.getReader();
      if (!reader) throw new CommercialError('COMMERCIAL_COMMAND_INVALID', 400);
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > 65536) { await reader.cancel(); throw new CommercialError('COMMERCIAL_BODY_TOO_LARGE', 413); }
        chunks.push(next.value);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CommercialError('COMMERCIAL_COMMAND_INVALID', 400); }
      if (!orderId) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['orderId','children'].includes(k))) throw new CommercialError('COMMERCIAL_COMMAND_INVALID', 400);
        const value = body as Record<string, unknown>;
        orderId = typeof value.orderId === 'string' ? value.orderId : '';
        body = { type: 'create', children: value.children };
      }
      const order = await input.service.execute(orderId, session.walletAddress, request.headers.get('idempotency-key')?.trim() ?? '', body);
      return Response.json({ order, requestId }, { headers });
    } catch (error) {
      const known = error instanceof CommercialError || error instanceof AuthError;
      return Response.json({ error: known ? error.code : 'COMMERCIAL_UNAVAILABLE', requestId }, { status: known ? error.status : 503, headers });
    }
  };
}
