import {
  officeCocosMessageSchema,
  officeHostMessageSchema,
  type OfficeCocosMessage,
  type OfficeSnapshotV2,
} from "@agent-market/shared-contracts";

type MessageLike = Pick<MessageEvent<unknown>, "data" | "origin" | "source">;

export function postOfficeSnapshot(frame: Window, expectedOrigin: string, snapshot: OfficeSnapshotV2): void {
  const message = officeHostMessageSchema.parse({
    type: "agent-market.office.snapshot.v2",
    payload: snapshot,
  });
  frame.postMessage(message, expectedOrigin);
}

export function parseOfficeCocosMessage(
  event: MessageLike,
  boundary: { expectedOrigin: string; expectedSource: Window },
): OfficeCocosMessage | null {
  if (event.origin !== boundary.expectedOrigin || event.source !== boundary.expectedSource) return null;
  const parsed = officeCocosMessageSchema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}
