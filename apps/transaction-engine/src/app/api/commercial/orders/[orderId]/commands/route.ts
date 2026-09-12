import { handleCommercialRequest } from '../../../../../../commercial/route-runtime';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  return handleCommercialRequest(request, (await context.params).orderId);
}
