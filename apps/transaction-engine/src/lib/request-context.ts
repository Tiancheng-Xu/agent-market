import { validate as isUuid, v7 as uuidv7 } from "uuid";

export function resolveRequestId(headers: Headers): string {
  const candidate = headers.get("x-request-id");
  return candidate !== null && isUuid(candidate) ? candidate : uuidv7();
}
