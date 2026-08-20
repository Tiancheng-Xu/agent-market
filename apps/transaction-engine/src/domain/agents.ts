export type AgentStatus = "draft" | "active" | "suspended";

export interface Agent {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  capabilities: string[];
  endpoint?: string;
  status: AgentStatus;
  version: number;
}

export interface CreateAgentInput {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  capabilities: string[];
  endpoint?: string;
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(code);
  }
  return normalized;
}

export function createAgent(input: CreateAgentInput): Agent {
  const capabilities = [...new Set(
    input.capabilities
      .map((capability) => capability.trim().toLowerCase())
      .filter(Boolean),
  )].sort();

  if (capabilities.length === 0) {
    throw new Error("AGENT_CAPABILITY_REQUIRED");
  }

  return {
    id: required(input.id, "AGENT_ID_REQUIRED"),
    ownerId: required(input.ownerId, "AGENT_OWNER_REQUIRED"),
    name: required(input.name, "AGENT_NAME_REQUIRED"),
    description: required(input.description, "AGENT_DESCRIPTION_REQUIRED"),
    capabilities,
    ...(input.endpoint?.trim() ? { endpoint: input.endpoint.trim() } : {}),
    status: "draft",
    version: 1,
  };
}

export function publishAgent(agent: Agent): Agent {
  if (agent.status !== "draft") {
    throw new Error("AGENT_STATUS_INVALID");
  }
  if (!agent.endpoint) {
    throw new Error("AGENT_ENDPOINT_REQUIRED");
  }

  return {
    ...agent,
    status: "active",
    version: agent.version + 1,
  };
}
