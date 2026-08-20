import { renderToReadableStream } from "react-dom/server.edge";

import { ServerApp } from "./ssr/ServerApp";

export function renderRouteStream(
  pathname: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  return renderToReadableStream(<ServerApp pathname={pathname} />, {
    signal,
    onError(error) {
      return error instanceof Error ? error.name : "AgentMarketRenderError";
    },
  });
}
