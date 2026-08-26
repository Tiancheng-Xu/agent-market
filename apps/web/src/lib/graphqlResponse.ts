export async function parseGraphqlResponse(response: Response): Promise<unknown> {
  const body = await response.text();

  if (!body.trim()) {
    throw new Error("GRAPHQL_GATEWAY_UNAVAILABLE");
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("GRAPHQL_GATEWAY_INVALID_RESPONSE");
  }
}
