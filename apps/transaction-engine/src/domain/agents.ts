import {
  beginAgentRevision,
  createAgentLifecycle,
  transitionAgentLifecycle,
  type AgentLifecycle,
  type AgentLifecycleActorRole,
  type AgentLifecycleStatus,
} from "@agent-market/shared-contracts";

export type AgentStatus = AgentLifecycleStatus;

export type Agent = {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  capabilities: string[];
  endpoint?: string;
  lifecycle: AgentLifecycle;
  status: AgentLifecycleStatus;
  version: number;
};

export type CreateAgentInput = Omit<Agent, "lifecycle" | "status" | "version"> & {
  occurredAt?: string;
};

type TransitionMetadata = {
  actorRole: AgentLifecycleActorRole;
  reasonCode: string;
  occurredAt?: string;
};

const normalizeCapabilities = (values: string[]) =>
  [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();

const metadata = ({ actorRole, reasonCode, occurredAt }: TransitionMetadata) => ({
  actorRole,
  reasonCode,
  occurredAt: occurredAt ?? new Date().toISOString(),
});

const withLifecycle = (agent: Agent, lifecycle: AgentLifecycle): Agent => ({
  ...agent,
  lifecycle,
  status: lifecycle.status,
  version: lifecycle.version,
});

export function createAgent(input: CreateAgentInput): Agent {
  const capabilities = normalizeCapabilities(input.capabilities);
  if (!input.id.trim() || !input.ownerId.trim() || !input.name.trim() || !input.description.trim()) {
    throw new Error("AGENT_FIELDS_REQUIRED");
  }
  if (capabilities.length === 0) {
    throw new Error("AGENT_CAPABILITY_REQUIRED");
  }

  const lifecycle = createAgentLifecycle({
    actorRole: "owner",
    reasonCode: "owner_created",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  });

  return {
    ...input,
    id: input.id.trim(),
    ownerId: input.ownerId.trim(),
    name: input.name.trim(),
    description: input.description.trim(),
    capabilities,
    lifecycle,
    status: lifecycle.status,
    version: lifecycle.version,
  };
}

export function submitAgentForReview(agent: Agent, input: Omit<TransitionMetadata, "actorRole">): Agent {
  if (!agent.endpoint) {
    throw new Error("AGENT_ENDPOINT_REQUIRED");
  }
  return withLifecycle(
    agent,
    transitionAgentLifecycle(agent.lifecycle, "reviewing", metadata({ ...input, actorRole: "owner" })),
  );
}

export function publishAgent(agent: Agent, input?: Omit<TransitionMetadata, "actorRole">): Agent {
  if (!agent.endpoint) {
    throw new Error("AGENT_ENDPOINT_REQUIRED");
  }
  return withLifecycle(
    agent,
    transitionAgentLifecycle(
      agent.lifecycle,
      "published",
      metadata({
        actorRole: "reviewer",
        reasonCode: input?.reasonCode ?? "review_passed",
        ...(input?.occurredAt ? { occurredAt: input.occurredAt } : {}),
      }),
    ),
  );
}

export function pauseAgent(agent: Agent, input: Omit<TransitionMetadata, "actorRole">): Agent {
  return withLifecycle(
    agent,
    transitionAgentLifecycle(agent.lifecycle, "paused", metadata({ ...input, actorRole: "owner" })),
  );
}

export function resumeAgent(agent: Agent, input: Omit<TransitionMetadata, "actorRole">): Agent {
  return withLifecycle(
    agent,
    transitionAgentLifecycle(agent.lifecycle, "published", metadata({ ...input, actorRole: "owner" })),
  );
}

export function retireAgent(agent: Agent, input: Omit<TransitionMetadata, "actorRole">): Agent {
  return withLifecycle(
    agent,
    transitionAgentLifecycle(agent.lifecycle, "retired", metadata({ ...input, actorRole: "owner" })),
  );
}

export function startAgentRevision(agent: Agent, input: Omit<TransitionMetadata, "actorRole">): Agent {
  return withLifecycle(
    agent,
    beginAgentRevision(agent.lifecycle, metadata({ ...input, actorRole: "owner" })),
  );
}
