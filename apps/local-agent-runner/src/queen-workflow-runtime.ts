import { END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";

const FrameworkStateSchema = z.object({
  operationName: z.string(),
  taskId: z.string().uuid().optional(),
  nodeId: z.string().optional(),
  stages: z.array(z.string()).default([]),
  operationPolicy: z.string().optional(),
});

export type QueenFrameworkRuntime = {
  execute(input: z.infer<typeof FrameworkStateSchema>): Promise<z.infer<typeof FrameworkStateSchema>>;
  executeOperation?(input: z.infer<typeof FrameworkStateSchema>, operation: () => Promise<void>): Promise<z.infer<typeof FrameworkStateSchema>>;
};

export function createQueenFrameworkRuntime(): QueenFrameworkRuntime {
  const graph = new StateGraph(FrameworkStateSchema)
    .addNode("normalize", (state) => ({
      ...state,
      stages: [...state.stages, "langgraph:normalize"],
    }))
    .addNode("route", async (state) => ({
      ...state,
      operationPolicy: operationToPolicy(state.operationName),
      stages: [...state.stages, `langgraph:${operationToPolicy(state.operationName)}`],
    }))
    .addNode("policy-check", async (state) => ({
      ...state,
      stages: [...state.stages, "langgraph:policy-check"],
    }))
    .addEdge(START, "normalize")
    .addEdge("normalize", "route")
    .addEdge("route", "policy-check")
    .addEdge("policy-check", END)
    .compile();

  return {
    execute: async (input) => graph.invoke(input),
    executeOperation: async (input, operation) => {
      // Each invocation owns its callback; concurrent requests never share mutable dispatch state.
      const execute = async (state: z.infer<typeof FrameworkStateSchema>) => {
        await operation();
        return { ...state, stages: [...state.stages, `langgraph:executed:${executionNode(state.operationName)}`] };
      };
      const executionGraph = new StateGraph(FrameworkStateSchema)
        .addNode("policy", async (state) => graph.invoke(state))
        .addNode("queen", execute)
        .addNode("agent", execute)
        .addNode("judge", execute)
        .addNode("red_team", execute)
        .addNode("repair", execute)
        .addNode("final_arbiter", execute)
        .addNode("learning", execute)
        .addEdge(START, "policy")
        .addConditionalEdges("policy", (state) => executionNode(state.operationName), {
          queen: "queen", agent: "agent", judge: "judge", red_team: "red_team",
          repair: "repair", final_arbiter: "final_arbiter", learning: "learning",
        })
        .addEdge("queen", END)
        .addEdge("agent", END)
        .addEdge("judge", END)
        .addEdge("red_team", END)
        .addEdge("repair", END)
        .addEdge("final_arbiter", END)
        .addEdge("learning", END)
        .compile();
      return executionGraph.invoke(input);
    },
  };
}

function executionNode(operationName: string) {
  switch (operationName) {
    case "SubmitNodeOutput": return "agent";
    case "JudgeNodeOutput": return "judge";
    case "RequestAdversarialReview": return "red_team";
    case "RepairNode": return "repair";
    case "FinalArbitrate": return "final_arbiter";
    case "WriteLearningLoop": return "learning";
    default: return "queen";
  }
}

function operationToPolicy(operationName: string): string {
  if (operationName.startsWith("Amend") || operationName.startsWith("Confirm") || operationName.startsWith("Propose")) {
    return "graph-management";
  }
  if (operationName.startsWith("Rank") || operationName.startsWith("Select") || operationName.startsWith("Accept")) {
    return "selection";
  }
  if (operationName.startsWith("Submit") || operationName.startsWith("Judge") || operationName.startsWith("Request") || operationName.startsWith("Repair") || operationName.startsWith("Final") || operationName.startsWith("Write")) {
    return "execution";
  }
  if (operationName.startsWith("Start")) {
    return "execution-control";
  }
  return "default";
}
