// Keep this module free of Node, database and business-runtime imports.
export interface ScheduleIdentity {
  scopeId: string;
  taskId: string;
  graphRevision: number;
  taskFingerprint: string;
}

export interface ScheduleSnapshot {
  // These values must come from the current business database, never a Signal.
  deadlineAt: number;
  terminal: boolean;
  approvalRef: string | null;
}

export type DispatchOutcome = "committed" | "duplicate-committed" | "busy" | "uncertain";
export type ScheduleResult = "business-terminal" | "reconciliation-required";

export interface TemporalActivities {
  inspectSchedule(identity: ScheduleIdentity): Promise<ScheduleSnapshot>;
  resumeApproval(identity: ScheduleIdentity, approvalRef: string): Promise<DispatchOutcome>;
  dispatchDeadline(identity: ScheduleIdentity): Promise<DispatchOutcome>;
}

export const SCHEDULE_CHANGED_SIGNAL = "queenScheduleChanged";
