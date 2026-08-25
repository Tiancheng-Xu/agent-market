import { describe, expect, it } from "vitest";

import { publicAgentCatalog } from "./agentCatalog";

describe("owner-trained catalog artifacts", () => {
  it("lists the code and image artifacts as ready but pending Agent Market smoke", () => {
    const entries = publicAgentCatalog.filter((entry) =>
      ["personal-code-agent", "personal-image-agent"].includes(entry.id),
    );

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        ownership: "owner-trained",
        provider: "ollama",
        artifactStatus: "ready",
        verification: "pending-smoke",
        readinessScore: 30,
        visibility: "private",
        selectableBy: "owner-only",
        source: "Tiancheng-Xu/personal-ai-agent",
        license: "Apache-2.0",
      });
      expect(entry.modelDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("does not expose model files, private release paths, or weights", () => {
    const serialized = JSON.stringify(publicAgentCatalog);

    expect(serialized).not.toContain(".gguf");
    expect(serialized).not.toContain("Modelfile");
    expect(serialized).not.toContain("/Users/");
  });
});
