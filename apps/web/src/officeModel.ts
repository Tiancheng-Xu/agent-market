export type OfficeTaskStatus = "in_progress" | "completed";

export type OfficeAgentSeat = {
  agentId: string;
  displayName: string;
  role: string;
  score: number;
  activity?: "idle" | "walking" | "thinking" | "working" | "reviewing" | "waiting" | "done" | "failed" | "offline";
};

export type OfficeTaskDesk = {
  taskId: string;
  ownerWallet: string;
  ownerLabel: string;
  title: string;
  category: string;
  tags: string[];
  status: OfficeTaskStatus;
  agents: OfficeAgentSeat[];
  nodeInput?: string;
  nodeOutput?: string;
  downloadableResult?: string;
};

export type VisibleOfficeDesk = Omit<OfficeTaskDesk, "nodeInput" | "nodeOutput" | "downloadableResult"> & {
  access: "owner" | "visitor";
  nodeInput?: string;
  nodeOutput?: string;
  downloadableResult?: string;
};

export function visibleDeskForWallet(desk: OfficeTaskDesk, wallet: string | null): VisibleOfficeDesk {
  const isOwner = wallet !== null && desk.ownerWallet.toLowerCase() === wallet.toLowerCase();
  if (isOwner) return { ...desk, access: "owner" };
  const { nodeInput: _nodeInput, nodeOutput: _nodeOutput, downloadableResult: _downloadableResult, ...publicDesk } = desk;
  return { ...publicDesk, access: "visitor" };
}

export function filterOfficeDesks(desks: OfficeTaskDesk[], status: "all" | OfficeTaskStatus): OfficeTaskDesk[] {
  return status === "all" ? desks : desks.filter((desk) => desk.status === status);
}
