import {
  AgentLifecycleSchema,
  beginAgentRevision,
  transitionAgentLifecycle,
  type AgentLifecycle,
  type AgentLifecycleStatus,
} from "@agent-market/shared-contracts";

import { saveOwnerAgent, type OwnerAgentRecord } from "./ownerAgentRegistry";

export type LifecycleOwnerAgent = OwnerAgentRecord & { lifecycle?: AgentLifecycle };

const importedStatus = (record: OwnerAgentRecord): AgentLifecycleStatus => {
  const listing = String(record.listingStatus);
  if (listing.includes("pending")) return "reviewing";
  if (listing.includes("rejected")) return "draft";
  if (record.selectableBy === "public-market" || record.selectableBy === "owner-only") return "published";
  return "draft";
};

export function deriveOwnerAgentLifecycle(record: LifecycleOwnerAgent): AgentLifecycle {
  if (record.lifecycle) return AgentLifecycleSchema.parse(record.lifecycle);
  const status = importedStatus(record);
  return AgentLifecycleSchema.parse({
    status,
    version: 1,
    history: [{
      from: null,
      to: status,
      version: 1,
      actorRole: "system",
      reasonCode: "legacy_registry_import",
      occurredAt: record.createdAt,
    }],
  });
}

export function nextOwnerAgentLifecycle(
  record: LifecycleOwnerAgent,
  action: "submit" | "publish" | "pause" | "resume" | "retire" | "revise",
  occurredAt: string,
): AgentLifecycle {
  const lifecycle = deriveOwnerAgentLifecycle(record);
  if (action === "revise") {
    return beginAgentRevision(lifecycle, {
      actorRole: "owner",
      reasonCode: "owner_started_revision",
      occurredAt,
    });
  }
  const targetByAction = {
    submit: "reviewing",
    publish: "published",
    pause: "paused",
    resume: "published",
    retire: "retired",
  } as const;
  return transitionAgentLifecycle(lifecycle, targetByAction[action], {
    actorRole: action === "publish" ? "reviewer" : "owner",
    reasonCode: action === "publish" ? "platform_review_passed" : `owner_${action}`,
    occurredAt,
  });
}

export async function persistOwnerAgentLifecycle(
  record: LifecycleOwnerAgent,
  action: "submit" | "publish" | "pause" | "resume" | "retire" | "revise",
): Promise<LifecycleOwnerAgent> {
  const updated = {
    ...record,
    lifecycle: nextOwnerAgentLifecycle(record, action, new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
  await saveOwnerAgent(updated);
  return updated;
}
