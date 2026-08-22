import { END, START, StateGraph } from "@langchain/langgraph";
import { Mastra } from "@mastra/core";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

const FrameworkStateSchema = z.object({
  operationName: z.string(),
  taskId: z.string().optional(),
  nodeId: z.string().optional(),
  runtime: z.object({
    mastra: z.literal("registered"),
    langGraph: z.literal("compiled"),
  }).optional(),
  stages: z.array(z.string()).default([]),
});

export type QueenFrameworkRuntime = {
  mastra: Mastra;
  execute(input: z.infer<typeof FrameworkStateSchema>): Promise<z.infer<typeof FrameworkStateSchema>>;
};

const normalizeStep = createStep({
  id: "normalize-queen-operation",
  inputSchema: FrameworkStateSchema,
  outputSchema: FrameworkStateSchema,
  execute: async ({ inputData }) => ({
    ...inputData,
    stages: [...inputData.stages, "mastra:normalize"],
  }),
});

const langGraphStep = createStep({
  id: "execute-langgraph-state",
  inputSchema: FrameworkStateSchema,
  outputSchema: FrameworkStateSchema,
  execute: async ({ inputData }) => executeLangGraph(inputData),
});

const queenWorkflow = createWorkflow({
  id: "agent-market-queen-orchestration",
  inputSchema: FrameworkStateSchema,
  outputSchema: FrameworkStateSchema,
})
  .then(normalizeStep)
  .then(langGraphStep)
  .commit();

export function createQueenFrameworkRuntime(): QueenFrameworkRuntime {
  const mastra = new Mastra({
    workflows: {
      queenOrchestration: queenWorkflow,
    },
    logger: false,
  });

  return {
    mastra,
    execute: executeLangGraph,
  };
}

async function executeLangGraph(input: z.infer<typeof FrameworkStateSchema>): Promise<z.infer<typeof FrameworkStateSchema>> {
  const graph = new StateGraph(FrameworkStateSchema)
    .addNode("runtime-boundary", async (state) => ({
      ...state,
      runtime: { mastra: "registered" as const, langGraph: "compiled" as const },
      stages: [...state.stages, "langgraph:runtime-boundary"],
    }))
    .addNode("policy-gate", async (state) => ({
      ...state,
      stages: [...state.stages, "langgraph:policy-gate"],
    }))
    .addEdge(START, "runtime-boundary")
    .addEdge("runtime-boundary", "policy-gate")
    .addEdge("policy-gate", END)
    .compile();

  return graph.invoke(input);
}

