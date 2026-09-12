import { handleCommercialRequest } from '../../../../commercial/route-runtime';
export const runtime = 'nodejs';
export const POST = (request: Request) => handleCommercialRequest(request);
