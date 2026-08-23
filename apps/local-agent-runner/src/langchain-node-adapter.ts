import { RunnableLambda } from "@langchain/core/runnables";

import type { QueenAgentExecutionRequest } from "./queen-orchestrator";

export type AgentNodeAdapter = {
  invoke(request: QueenAgentExecutionRequest): Promise<string>;
};

export function createLangChainNodeAdapter(
  executeAgentText: (request: QueenAgentExecutionRequest) => Promise<string>,
): AgentNodeAdapter {
  const runnable = RunnableLambda.from(async (request: QueenAgentExecutionRequest) => executeAgentText(request));
  return {
    invoke(request) {
      return runnable.invoke(request, {
        metadata: {
          taskId: request.taskId,
          nodeId: request.nodeId ?? "task",
          agentId: request.agentId,
          role: request.role,
        },
        runName: `agent-market-${request.role}`,
      });
    },
  };
}
