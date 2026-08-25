import { z } from "zod";

const UuidSchema = z.string().uuid();
const HexDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const AgentNodeExchangeSchema = z.strictObject({
  requestId: UuidSchema,
  runId: UuidSchema,
  taskId: z.string().min(1).max(96),
  nodeId: z.string().min(1).max(96),
  agentId: z.string().min(1).max(160),
  direction: z.enum(["ingress", "egress"]),
  payload: z.strictObject({
    kind: z.enum(["node-input", "node-output"]),
    contentType: z.enum(["text/plain", "application/json"]),
    content: z.string().max(65_536),
    sha256: HexDigestSchema,
  }),
});

export type AgentNodeExchange = z.infer<typeof AgentNodeExchangeSchema>;
