import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { OrderDetailPage } from "./OrderDetailPage";
import { createOrderQueryClient } from "./orderQueryClient";

export type OrderDetailRouteProps = {
  walletAddress?: string | null;
};

export default function OrderDetailRoute({ walletAddress = null }: OrderDetailRouteProps) {
  return <OrderSession key={walletAddress ?? "guest"} walletAddress={walletAddress} />;
}

function OrderSession({ walletAddress = null }: OrderDetailRouteProps) {
  const { id } = useParams();
  const [client] = useState(createOrderQueryClient);
  useEffect(() => () => {
    void client.cancelQueries().catch(() => undefined);
    client.clear();
  }, [client]);
  return (
    <QueryClientProvider client={client}>
      <OrderDetailPage key={`${id}:${walletAddress ?? "guest"}`} walletAddress={walletAddress} />
    </QueryClientProvider>
  );
}
