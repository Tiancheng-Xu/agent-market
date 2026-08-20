import { type RenderState, safeSerializeRenderState } from "./renderState";

const rootMarker = '<div id="root"></div>';
const encoder = new TextEncoder();

function splitTemplate(template: string): [string, string] {
  const first = template.indexOf(rootMarker);
  if (first < 0 || template.indexOf(rootMarker, first + 1) >= 0) {
    throw new Error("SSR_ROOT_MARKER_INVALID");
  }
  return [template.slice(0, first), template.slice(first + rootMarker.length)];
}

function appendRenderState(suffix: string, state: RenderState): string {
  const bodyEnd = suffix.lastIndexOf("</body>");
  if (bodyEnd < 0) throw new Error("SSR_BODY_MARKER_INVALID");
  const stateScript = `<script id="__AGENT_MARKET_RENDER_STATE__" type="application/json">${safeSerializeRenderState(state)}</script>`;
  return `${suffix.slice(0, bodyEnd)}${stateScript}${suffix.slice(bodyEnd)}`;
}

export function composeSsrDocument(
  template: string,
  app: ReadableStream<Uint8Array>,
  state: RenderState,
): ReadableStream<Uint8Array> {
  const [prefix, suffix] = splitTemplate(template);
  const reader = app.getReader();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(
          `${prefix}<div id="root" data-render-mode="ssr">`,
        ));
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          controller.enqueue(result.value);
        }
        controller.enqueue(encoder.encode(
          `</div>${appendRenderState(suffix, state)}`,
        ));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function buildCsrFallbackDocument(
  template: string,
  state: RenderState,
): string {
  const [prefix, suffix] = splitTemplate(template);
  return `${prefix}<div id="root" data-render-mode="csr-fallback"></div>${appendRenderState(suffix, state)}`;
}
