import { describe, expect, it } from "vitest";

import { createOwnerAgentRecord, determineAgentAdmission, isMarketVisible } from "./ownerAgentRegistry";

describe("owner Agent admission policy", () => {
  it("keeps local Ollama agents private and owner-only", () => {
    expect(determineAgentAdmission({ provider: "ollama", pricing: "free" })).toMatchObject({
      listingStatus: "owner-private",
      selectableBy: "owner-only",
      marketVisible: false,
    });
  });

  it("lists free HTTPS agents directly but gates paid agents on a platform test", () => {
    expect(determineAgentAdmission({ provider: "https", pricing: "free" })).toMatchObject({
      listingStatus: "marketplace",
      selectableBy: "public-market",
      marketVisible: true,
    });
    expect(determineAgentAdmission({ provider: "https", pricing: "paid" })).toMatchObject({
      listingStatus: "pending-platform-test",
      marketVisible: false,
    });
    expect(determineAgentAdmission({ provider: "https", pricing: "paid", platformTestStatus: "passed" })).toMatchObject({
      listingStatus: "marketplace",
      marketVisible: true,
    });
  });

  it("normalizes metadata without persisting credentials", () => {
    const record = createOwnerAgentRecord({
      ownerWallet: "0x1111111111111111111111111111111111111111",
      displayName: "  My Agent  ",
      category: "Research",
      description: "Public description",
      tags: ["RAG", "rag", " citations "],
      provider: "https",
      modelTag: "custom-model-v1",
      endpoint: "https://agent.example/api",
      pricing: "free",
      pricePerTaskYd: 100,
    }, new Date("2026-08-23T00:00:00.000Z"));

    expect(record).toMatchObject({
      displayName: "My Agent",
      tags: ["rag", "citations"],
      pricePerTaskYd: 0,
      listingStatus: "marketplace",
    });
    expect(isMarketVisible(record)).toBe(true);
    expect(JSON.stringify(record)).not.toMatch(/apiKey|secret|11434/i);
  });
});
