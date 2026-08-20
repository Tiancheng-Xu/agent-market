export type RenderMode = "ssr" | "csr-fallback";

export interface RenderState {
  mode: RenderMode;
  pathname: string;
  version: string;
}

const allowedKeys = new Set(["mode", "pathname", "version"]);

export function safeSerializeRenderState(state: RenderState): string {
  return JSON.stringify(state)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function parseRenderState(value: string | null): RenderState | undefined {
  if (!value) return undefined;

  try {
    const candidate: unknown = JSON.parse(value);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return undefined;
    }

    const record = candidate as Record<string, unknown>;
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
      return undefined;
    }
    if (record.mode !== "ssr" && record.mode !== "csr-fallback") {
      return undefined;
    }
    if (
      typeof record.pathname !== "string"
      || !record.pathname.startsWith("/")
      || record.pathname.length > 256
    ) {
      return undefined;
    }
    if (typeof record.version !== "string" || record.version.length > 64) {
      return undefined;
    }

    return {
      mode: record.mode,
      pathname: record.pathname,
      version: record.version,
    };
  } catch {
    return undefined;
  }
}
