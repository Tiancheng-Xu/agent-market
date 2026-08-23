import { describe, expect, it, vi } from "vitest";

import { createLangChainNodeAdapter } from "./langchain-node-adapter";

describe("LangChain node adapter", () => {
  it("keeps node identity while delegating one model call", async () => {
    const execute = vi.fn(async () => "node output");
    const adapter = createLangChainNodeAdapter(execute);
    const request = { taskId: "task-1", nodeId: "judge-1", agentId: "judge-a", role: "judge" as const, messages: [{ role: "user" as const, content: "judge" }] };
    await expect(adapter.invoke(request)).resolves.toBe("node output");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(request);
  });
});
