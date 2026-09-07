import { describe, expect, it } from "vitest";

import { createQueenOrchestrator } from "./queen-orchestrator";
import { MemoryQueenWorkflowStore, type QueenWorkflowSnapshot, type QueenWorkflowStore } from "./queen-workflow-store";

const taskId = "11111111-1111-4111-8111-111111111111";
const request = (operationName: "ProposeTaskGraph" | "AmendTaskGraph", input: Record<string, unknown>) => ({
  query: `mutation ${operationName}($input: Input!) { ${operationName}(input: $input) { taskId } }`,
  operationName,
  variables: { input },
});

describe("Queen workflow persistence", () => {
  it("rehydrates a graph in a new orchestrator and advances its revision", async () => {
    const store = new MemoryQueenWorkflowStore();
    const first = createQueenOrchestrator({ agents: [], queenAgentId: "queen-router-v1", workflowStore: store });
    const proposed = await first.handleGraphql(request("ProposeTaskGraph", {
      taskId,
      requirement: "Build a verified workflow",
      queenAgentId: "queen-router-v1",
    }));
    const graph = proposed.data?.["proposeTaskGraph"];
    expect(graph?.graphRevision).toBe(1);

    const second = createQueenOrchestrator({ agents: [], queenAgentId: "queen-router-v1", workflowStore: store });
    const amended = await second.handleGraphql(request("AmendTaskGraph", {
      taskId,
      nodes: graph.nodes,
      edges: graph.edges,
    }));
    expect(amended.data?.["amendTaskGraph"]?.graphRevision).toBe(2);
    expect((await store.load(taskId))?.recordVersion).toBe(2);
  });

  it("does not expose a failed CAS mutation through shared in-memory state", async () => {
    const backing = new MemoryQueenWorkflowStore();
    let failNextSave = false;
    const store: QueenWorkflowStore = {
      load: (id) => backing.load(id),
      async save(snapshot: QueenWorkflowSnapshot, expectedRecordVersion: number) {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("QUEEN_WORKFLOW_VERSION_CONFLICT");
        }
        await backing.save(snapshot, expectedRecordVersion);
      },
    };
    const orchestrator = createQueenOrchestrator({ agents: [], queenAgentId: "queen-router-v1", workflowStore: store });
    const proposed = await orchestrator.handleGraphql(request("ProposeTaskGraph", {
      taskId,
      requirement: "Build a verified workflow",
      queenAgentId: "queen-router-v1",
    }));
    const graph = proposed.data?.["proposeTaskGraph"];
    failNextSave = true;

    const conflicted = await orchestrator.handleGraphql(request("AmendTaskGraph", {
      taskId,
      nodes: graph.nodes.map((node: { nodeId: string }) => node.nodeId === "execute-1" ? { ...node, title: "Must not leak" } : node),
      edges: graph.edges,
    }));
    const retried = await orchestrator.handleGraphql(request("AmendTaskGraph", {
      taskId,
      nodes: graph.nodes,
      edges: graph.edges,
    }));

    expect(conflicted.errors?.[0]?.message).toBe("QUEEN_WORKFLOW_VERSION_CONFLICT");
    expect(retried.data?.["amendTaskGraph"]?.graphRevision).toBe(2);
    expect(retried.data?.["amendTaskGraph"]?.nodes.find((node: { nodeId: string }) => node.nodeId === "execute-1")?.title).toBe("Execute");
    expect((await backing.load(taskId))?.recordVersion).toBe(2);
  });
});
