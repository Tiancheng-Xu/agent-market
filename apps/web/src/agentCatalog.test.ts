import { describe, expect, it } from "vitest";

import { publicAgentCatalog } from "./agentCatalog";

describe("owner-trained catalog artifacts", () => {
  it("lists the code and image artifacts as locally verified by Agent Market", () => {
    const entries = publicAgentCatalog.filter((entry) =>
      ["personal-code-agent", "personal-image-agent"].includes(entry.id),
    );

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        ownership: "owner-trained",
        provider: "ollama",
        artifactStatus: "ready",
        verification: "verified",
        verifiedOperations: 1,
        visibility: "private",
        selectableBy: "owner-only",
        source: "Tiancheng-Xu/personal-ai-agent",
        license: "Apache-2.0",
      });
      expect(entry.modelDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.fromEntries(entries.map((entry) => [entry.id, entry.modelDigest]))).toEqual({
      "personal-code-agent": "4b9c60671fff53a198630f9aaf6b76d7d46c356359f41030f52e61f77f7b83bb",
      "personal-image-agent": "2fa405e1244629244798cb4d7b8f4b3a5dd9e47aaf9ea7329e8dbe27bd32cffd",
    });
  });

  it("does not expose model files, private release paths, or weights", () => {
    const serialized = JSON.stringify(publicAgentCatalog);

    expect(serialized).not.toContain(".gguf");
    expect(serialized).not.toContain("Modelfile");
    expect(serialized).not.toContain("/Users/");
  });
});
