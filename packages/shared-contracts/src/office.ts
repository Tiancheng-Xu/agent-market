import { z } from "zod";

const officeStatusSchema = z.enum(["in_progress", "completed"]);
const officeFilterSchema = z.enum(["all", "in_progress", "completed"]);
export const officeActivitySchema = z.enum([
  "idle",
  "walking",
  "thinking",
  "working",
  "reviewing",
  "waiting",
  "done",
  "failed",
  "offline",
]);

export const officeAgentSeatSchema = z.object({
  agentId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(120),
  role: z.string().min(1).max(80),
  score: z.number().finite().min(0).max(100),
  activity: officeActivitySchema,
}).strict();

export const publicOfficeDeskSchema = z.object({
  taskId: z.string().min(1).max(128),
  title: z.string().min(1).max(240),
  category: z.string().min(1).max(80),
  tags: z.array(z.string().min(1).max(48)).max(12),
  status: officeStatusSchema,
  agents: z.array(officeAgentSeatSchema).max(12),
  isOwner: z.boolean(),
}).strict();

export const officeSnapshotSchema = z.object({
  version: z.literal(2),
  generatedAt: z.string().datetime(),
  locale: z.enum(["zh-CN", "en"]).optional(),
  statusFilter: officeFilterSchema,
  desks: z.array(publicOfficeDeskSchema).max(100),
}).strict();

export const officeHostMessageSchema = z.object({
  type: z.literal("agent-market.office.snapshot.v2"),
  payload: officeSnapshotSchema,
}).strict();

export const officeCocosMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent-market.office.ready.v2") }).strict(),
  z.object({
    type: z.literal("agent-market.office.select-desk.v2"),
    taskId: z.string().min(1).max(128),
  }).strict(),
]);

export type OfficeSnapshotV2 = z.infer<typeof officeSnapshotSchema>;
export type OfficeCocosMessage = z.infer<typeof officeCocosMessageSchema>;

type PrivateAgentSeat = Omit<z.infer<typeof officeAgentSeatSchema>, "activity"> & {
  activity?: z.infer<typeof officeActivitySchema>;
};

type PrivateOfficeDesk = Omit<z.infer<typeof publicOfficeDeskSchema>, "isOwner" | "agents"> & {
  agents: PrivateAgentSeat[];
  ownerWallet?: string;
  ownerLabel?: string;
  nodeInput?: string;
  nodeOutput?: string;
  downloadableResult?: string;
};

export function toPublicOfficeSnapshot(input: {
  generatedAt?: string;
  locale?: "zh-CN" | "en";
  statusFilter: z.infer<typeof officeFilterSchema>;
  desks: PrivateOfficeDesk[];
  viewerWallet?: string | null;
}): OfficeSnapshotV2 {
  const viewerWallet = input.viewerWallet?.toLowerCase();
  return officeSnapshotSchema.parse({
    version: 2,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    locale: input.locale ?? "zh-CN",
    statusFilter: input.statusFilter,
    desks: input.desks
      .filter((desk) => input.statusFilter === "all" || desk.status === input.statusFilter)
      .map((desk) => ({
        taskId: desk.taskId,
        title: desk.title,
        category: desk.category,
        tags: desk.tags,
        status: desk.status,
        agents: desk.agents.map((agent) => ({
          ...agent,
          activity: agent.activity ?? (desk.status === "completed"
            ? "done"
            : /judge|review|arbiter/i.test(agent.role)
              ? "reviewing"
              : "working"),
        })),
        isOwner: Boolean(viewerWallet && desk.ownerWallet?.toLowerCase() === viewerWallet),
      })),
  });
}
