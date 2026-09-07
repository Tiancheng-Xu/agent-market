import { QueryClient } from "@tanstack/react-query";

export const ORDER_QUERY_STALE_TIME_MS = 30_000;

export const orderQueryKeys = {
  order: (orderId: string) => ["order", orderId] as const,
  reputation: (agentId: string) => ["agent-reputation", agentId] as const,
};

export function createOrderQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: ORDER_QUERY_STALE_TIME_MS,
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

let browserOrderQueryClient: QueryClient | undefined;

export function getOrderQueryClient(): QueryClient {
  if (typeof window === "undefined") return createOrderQueryClient();
  browserOrderQueryClient ??= createOrderQueryClient();
  return browserOrderQueryClient;
}
