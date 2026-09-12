import { condition, defineSignal, isCancellation, proxyActivities, setHandler } from "@temporalio/workflow";
import { SCHEDULE_CHANGED_SIGNAL, type ScheduleIdentity, type ScheduleResult, type TemporalActivities } from "./contracts";
import { TemporalPlanningReferenceSchema, type TemporalPlanningReference, type TemporalPlanningResult,
  type TemporalPlanningActivities } from "./planning-contracts";

const planning = proxyActivities<TemporalPlanningActivities>({
  startToCloseTimeout: "4 minutes",
  scheduleToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

export async function queenPlanningRequest(reference: TemporalPlanningReference): Promise<TemporalPlanningResult> {
  const parsed = TemporalPlanningReferenceSchema.safeParse(reference);
  if (!parsed.success) return { outcome: "rejected" };
  try {
    return await planning.consumePlanning(parsed.data);
  } catch (error) {
    if (isCancellation(error)) throw error;
    // Timed-out execution may still complete. Never resubmit or compensate here.
    return { outcome: "uncertain" };
  }
}

const reads = proxyActivities<Pick<TemporalActivities, "inspectSchedule">>({
  startToCloseTimeout: "30 seconds",
  scheduleToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "10 seconds" },
});
const writes = proxyActivities<Pick<TemporalActivities, "resumeApproval" | "dispatchDeadline">>({
  startToCloseTimeout: "30 minutes",
  scheduleToCloseTimeout: "31 minutes",
  // Timeout/crash does not prove that the external operation failed.
  retry: { maximumAttempts: 1 },
});

export const scheduleChanged = defineSignal(SCHEDULE_CHANGED_SIGNAL);

export async function queenOrderSchedule(identity: ScheduleIdentity): Promise<ScheduleResult> {
  let generation = 0;
  const dispatchedApprovals = new Set<string>();
  const dispatchedDeadlines = new Set<number>();
  setHandler(scheduleChanged, () => { generation += 1; });
  // Bound history, polling and the total scheduling window. A new scheduling
  // generation after this limit requires business-side reconciliation.
  for (let cycle = 0; cycle < 1000; cycle += 1) {
    const observed = generation;
    const snapshot = await reads.inspectSchedule(identity);
    if (snapshot.terminal) return "business-terminal";
    try {
      if (snapshot.deadlineAt <= Date.now() && !dispatchedDeadlines.has(snapshot.deadlineAt)) {
        const outcome = await writes.dispatchDeadline(identity);
        if (outcome !== "committed" && outcome !== "duplicate-committed") return "reconciliation-required";
        dispatchedDeadlines.add(snapshot.deadlineAt);
        continue;
      }
      if (snapshot.approvalRef && !dispatchedApprovals.has(snapshot.approvalRef)) {
        const outcome = await writes.resumeApproval(identity, snapshot.approvalRef);
        if (outcome !== "committed" && outcome !== "duplicate-committed") return "reconciliation-required";
        dispatchedApprovals.add(snapshot.approvalRef);
        continue;
      }
    } catch (error) {
      if (isCancellation(error)) throw error;
      // Never compensate after a transport error: the action may still be running.
      return "reconciliation-required";
    }
    // Signals only wake reads; a missed signal is recovered by bounded polling.
    const deadlineWait = dispatchedDeadlines.has(snapshot.deadlineAt)
      ? 3600000 : Math.max(1, snapshot.deadlineAt - Date.now());
    await condition(() => generation !== observed, Math.min(3600000, deadlineWait));
  }
  return "reconciliation-required";
}
