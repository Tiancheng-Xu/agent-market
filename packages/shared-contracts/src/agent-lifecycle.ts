import { z } from "zod";

export const AgentLifecycleStatusSchema = z.enum([
  "draft",
  "reviewing",
  "published",
  "paused",
  "retired",
]);

export type AgentLifecycleStatus = z.infer<typeof AgentLifecycleStatusSchema>;

export const AgentLifecycleActorRoleSchema = z.enum([
  "owner",
  "reviewer",
  "operator",
  "system",
]);

export type AgentLifecycleActorRole = z.infer<typeof AgentLifecycleActorRoleSchema>;

export const AgentLifecycleEventSchema = z.object({
  from: AgentLifecycleStatusSchema.nullable(),
  to: AgentLifecycleStatusSchema,
  version: z.number().int().positive(),
  actorRole: AgentLifecycleActorRoleSchema,
  reasonCode: z.string().trim().min(1).max(80),
  occurredAt: z.string().datetime(),
});

export type AgentLifecycleEvent = z.infer<typeof AgentLifecycleEventSchema>;

export const AgentLifecycleSchema = z.object({
  status: AgentLifecycleStatusSchema,
  version: z.number().int().positive(),
  history: z.array(AgentLifecycleEventSchema).min(1),
});

export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;

export type AgentLifecycleTransition = {
  actorRole: AgentLifecycleActorRole;
  reasonCode: string;
  occurredAt: string;
};

const allowedTransitions: Readonly<Record<AgentLifecycleStatus, readonly AgentLifecycleStatus[]>> = {
  draft: ["reviewing"],
  reviewing: ["draft", "published"],
  published: ["paused", "retired"],
  paused: ["published", "retired"],
  retired: [],
};

export function createAgentLifecycle(
  transition: AgentLifecycleTransition,
  version = 1,
): AgentLifecycle {
  return AgentLifecycleSchema.parse({
    status: "draft",
    version,
    history: [{ from: null, to: "draft", version, ...transition }],
  });
}

export function transitionAgentLifecycle(
  lifecycle: AgentLifecycle,
  target: AgentLifecycleStatus,
  transition: AgentLifecycleTransition,
): AgentLifecycle {
  const current = AgentLifecycleSchema.parse(lifecycle);
  if (!allowedTransitions[current.status].includes(target)) {
    throw new Error(`AGENT_LIFECYCLE_TRANSITION_FORBIDDEN:${current.status}:${target}`);
  }

  return AgentLifecycleSchema.parse({
    ...current,
    status: target,
    history: [
      ...current.history,
      { from: current.status, to: target, version: current.version, ...transition },
    ],
  });
}

export function beginAgentRevision(
  lifecycle: AgentLifecycle,
  transition: AgentLifecycleTransition,
): AgentLifecycle {
  const current = AgentLifecycleSchema.parse(lifecycle);
  if (current.status !== "published" && current.status !== "paused") {
    throw new Error(`AGENT_REVISION_FORBIDDEN:${current.status}`);
  }

  const version = current.version + 1;
  return AgentLifecycleSchema.parse({
    status: "draft",
    version,
    history: [
      ...current.history,
      { from: current.status, to: "draft", version, ...transition },
    ],
  });
}

export function isAgentVersionSelectable(lifecycle: AgentLifecycle): boolean {
  return AgentLifecycleSchema.parse(lifecycle).status === "published";
}
