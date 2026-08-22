import { describe, expect, it } from "vitest";

import {
  LiveChatHealthSchema,
  LiveAgentGraphqlRequestSchema,
  LiveChatRequestSchema,
  LiveChatSseEventSchema,
} from "./live-chat";

describe("live chat contracts", () => {
  it("accepts a public-safe chat request and SSE events", () => {
    const request = LiveChatRequestSchema.parse({
      requestId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "turn-123456",
      agentId: "personal-ai-agent-runtime-v4-1",
      messages: [{ role: "user", content: "Say hello." }],
    });

    expect(request.agentId).toBe("personal-ai-agent-runtime-v4-1");
    expect(
      LiveChatSseEventSchema.parse({
        event: "delta",
        requestId: request.requestId,
        delta: "hello",
      }),
    ).toMatchObject({ event: "delta" });
  });

  it("rejects tool-shaped roles and overlarge messages", () => {
    expect(() =>
      LiveChatRequestSchema.parse({
        agentId: "agent",
        messages: [{ role: "tool", content: "secret" }],
      }),
    ).toThrow();
    expect(() =>
      LiveChatRequestSchema.parse({
        agentId: "agent",
        messages: [{ role: "user", content: "x".repeat(4001) }],
      }),
    ).toThrow();
  });

  it("represents offline runtime health without private endpoints", () => {
    const health = LiveChatHealthSchema.parse({
      status: "offline",
      checkedAt: "2026-08-22T12:00:00.000Z",
      runtime: "edge",
      reasonCode: "RUNTIME_OFFLINE",
      agents: [],
    });

    expect(JSON.stringify(health)).not.toContain("11434");
  });

  it("carries public-safe agent access policy in runtime health", () => {
    const health = LiveChatHealthSchema.parse({
      status: "online",
      checkedAt: "2026-08-22T12:00:00.000Z",
      runtime: "local-runtime",
      agents: [{
        agentId: "personal-ai-agent-runtime-v4-1",
        displayName: "Personal AI Agent Runtime v4.1",
        provider: "ollama",
        ownership: "owner-trained",
        modelTag: "personal-ai-agent-runtime:v4.1",
        modelDigest: "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a",
        visibility: "private",
        selectableBy: "owner-only",
        status: "online",
      }],
    });

    expect(health.agents[0]!.selectableBy).toBe("owner-only");
  });

  it("accepts a sequential GraphQL orchestration input", () => {
    const request = LiveAgentGraphqlRequestSchema.parse({
      query: "mutation OrchestrateAgents($input: AgentOrchestrationInput!) { orchestrateAgents(input: $input) { finalOutput } }",
      operationName: "OrchestrateAgents",
      variables: {
        input: {
          requestId: "11111111-1111-4111-8111-111111111111",
          agentIds: ["personal-ai-agent-runtime-v4-1", "deepseek-deepseek-v4-flash"],
          messages: [{ role: "user", content: "Compare answers." }],
        },
      },
    });

    expect(request.variables.input.agentIds).toHaveLength(2);
  });
});
