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
  };
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
