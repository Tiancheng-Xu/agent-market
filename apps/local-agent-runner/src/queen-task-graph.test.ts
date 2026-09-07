import { Command, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { createQueenTaskGraph, queenTaskThreadId, QueenTaskStateSchema, type QueenTaskGraphPorts } from "./queen-task-graph";

const input = QueenTaskStateSchema.parse({ scopeId: "owner-test", taskId: "01900000-0000-7000-8000-000000000001", graphRevision: 1, taskFingerprint: `sha256:${"a".repeat(64)}`, riskLevel: "low" });
const config = { configurable: { thread_id: queenTaskThreadId(input) } };
const approval = { approved: true, graphRevision: 1, taskFingerprint: input.taskFingerprint };
function ports(): QueenTaskGraphPorts {
  return { authorize: vi.fn().mockResolvedValue(undefined), plan: vi.fn().mockResolvedValue("plan-ref"), execute: vi.fn().mockResolvedValue("output-ref"), judge: vi.fn().mockResolvedValue("approved"), repair: vi.fn().mockResolvedValue("repair-ref"), finalize: vi.fn().mockResolvedValue("final-ref") };
}

describe("task graph checkpoint semantics (memory only)", () => {
  it("fails closed when high-risk Red Team is unavailable", async () => {
    const p = ports(), g = createQueenTaskGraph(p, new MemorySaver());
    await g.invoke({ ...input, riskLevel: "high" }, config);
    await expect(g.invoke(new Command({ resume: approval }), config)).rejects.toThrow("QUEEN_RED_TEAM_UNAVAILABLE");
    expect(p.finalize).not.toHaveBeenCalled();
  });
  it("repeats Judge and Red Team after a high-risk repair", async () => {
    const p = ports();
    p.redTeam = vi.fn().mockResolvedValueOnce("needs_revision").mockResolvedValueOnce("approved");
    const g = createQueenTaskGraph(p, new MemorySaver());
    await g.invoke({ ...input, riskLevel: "high" }, config);
    const result = await g.invoke(new Command({ resume: approval }), config);
    expect(result.status).toBe("completed");
    expect(p.repair).toHaveBeenCalledTimes(1);
    expect(p.judge).toHaveBeenCalledTimes(2);
    expect(p.redTeam).toHaveBeenCalledTimes(2);
    expect(p.finalize).toHaveBeenCalledTimes(1);
  });
  it("waits for approval and resumes a rebuilt graph without repeating planning", async () => {
    const p = ports(), saver = new MemorySaver();
    await createQueenTaskGraph(p, saver).invoke(input, config);
    expect(p.execute).not.toHaveBeenCalled();
    const result = await createQueenTaskGraph(p, saver).invoke(new Command({ resume: approval }), config);
    expect(result.status).toBe("completed");
    expect(p.plan).toHaveBeenCalledTimes(1);
    expect(p.execute).toHaveBeenCalledTimes(1);
    expect(p.authorize).toHaveBeenCalledWith(expect.anything(), "approve");
  });
  it("rejects stale approval before execution", async () => {
    const p = ports(), g = createQueenTaskGraph(p, new MemorySaver());
    await g.invoke(input, config);
    await expect(g.invoke(new Command({ resume: { ...approval, graphRevision: 2 } }), config)).rejects.toThrow("QUEEN_APPROVAL_VERSION_MISMATCH");
    expect(p.execute).not.toHaveBeenCalled();
  });
  it("bounds repairs and never finalizes a rejected output", async () => {
    const p = ports(); vi.mocked(p.judge).mockResolvedValue("needs_revision");
    const g = createQueenTaskGraph(p, new MemorySaver());
    await g.invoke(input, config);
    const result = await g.invoke(new Command({ resume: approval }), config);
    expect(result.status).toBe("rejected");
    expect(p.repair).toHaveBeenCalledTimes(2);
    expect(p.finalize).not.toHaveBeenCalled();
  });
  it("does not share thread identities across scope or graph revisions", () => {
    expect(queenTaskThreadId({ ...input, scopeId: "public-test" })).not.toBe(config.configurable.thread_id);
    expect(queenTaskThreadId({ ...input, graphRevision: 2 })).not.toBe(config.configurable.thread_id);
  });
});
