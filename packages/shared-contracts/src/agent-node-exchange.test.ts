import { describe, expect, it } from "vitest";

import { AgentNodeExchangeSchema } from "./agent-node-exchange";

const base = {
  requestId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  taskId: "task-1",
  nodeId: "execute-1",
  agentId: "personal-code-agent",
  direction: "egress",
  payload: { kind: "node-output", contentType: "text/plain", content: "result", sha256: "a".repeat(64) },
} as const;

describe("Agent node exchange contract", () => {
  it("allows only task-node input and output envelopes", () => {
    expect(AgentNodeExchangeSchema.parse(base).payload.kind).toBe("node-output");
  });

  it("rejects arbitrary files, prompts, secrets, and workflow data as extra fields", () => {
    for (const extra of [
      { file: "model.gguf" },
      { apiKey: "secret" },
      { fullDag: { nodes: [] } },
      { rawPromptLog: "private" },
    ]) {
      expect(() => AgentNodeExchangeSchema.parse({ ...base, ...extra })).toThrow();
    }
  });
});
