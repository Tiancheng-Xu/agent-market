import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import {
  MemoryChainResourceRepository,
  buildTransactionExpectation,
  normalizeResourceId,
} from "./resources";

const RESOURCE_ID = "018f0f9c-8b35-7f31-8f11-75f06c12a521";

describe("chain resource authorization", () => {
  it("keeps wallet account resources isolated to vault methods", async () => {
    const repository = new MemoryChainResourceRepository([]);
    const publisher = Wallet.createRandom().address;
    const resource = await repository.createChainAccount(RESOURCE_ID, publisher);
    await expect(repository.requireAuthorized(resource.resourceId, publisher, "stake")).resolves.toMatchObject({ kind: "account" });
    await expect(repository.requireAuthorized(resource.resourceId, publisher, "createTask")).rejects.toMatchObject({ code: "CHAIN_ACCOUNT_METHOD_FORBIDDEN" });
  });

  it("normalizes resource ids and derives the exact floor-rounded 6% bond", async () => {
    const publisher = Wallet.createRandom().address;
    const repository = new MemoryChainResourceRepository([{
      resourceId: RESOURCE_ID.toUpperCase(), publisherWallet: publisher, agentWallet: null,
      budgetAtomic: "101", status: "open",
    }]);
    const resource = await repository.requireAuthorized(RESOURCE_ID, publisher, "createTask");
    expect(resource.resourceId).toBe(normalizeResourceId(RESOURCE_ID));
    expect(buildTransactionExpectation(resource, "createTask")).toEqual({
      resourceId: RESOURCE_ID, budgetAtomic: "101", bondAtomic: "6", agentWins: null,
    });
  });

  it("fails closed for missing resources, wrong owners, and invalid states", async () => {
    const publisher = Wallet.createRandom().address;
    const agent = Wallet.createRandom().address;
    const repository = new MemoryChainResourceRepository([{
      resourceId: RESOURCE_ID, publisherWallet: publisher, agentWallet: agent,
      budgetAtomic: "100", status: "assigned",
    }]);
    await expect(repository.requireAuthorized(
      "018f0f9c-8b35-7f31-8f11-75f06c12a522", publisher, "acceptTask",
    )).rejects.toThrow("CHAIN_RESOURCE_NOT_FOUND");
    await expect(repository.requireAuthorized(
      RESOURCE_ID, Wallet.createRandom().address, "acceptTask",
    )).rejects.toThrow("CHAIN_RESOURCE_FORBIDDEN");
    await expect(repository.requireAuthorized(RESOURCE_ID, agent, "submitWork"))
      .rejects.toThrow("CHAIN_RESOURCE_STATE_INVALID");
  });

  it("allows only the configured platform arbiter to resolve a V3 workflow task", async () => {
    const publisher = Wallet.createRandom().address;
    const arbiter = Wallet.createRandom().address;
    const repository = new MemoryChainResourceRepository([{
      resourceId: RESOURCE_ID, publisherWallet: publisher, agentWallet: null,
      budgetAtomic: "100", status: "disputed",
    }], [], arbiter);
    await expect(repository.requireAuthorized(RESOURCE_ID, arbiter, "resolveWorkflowTask"))
      .resolves.toMatchObject({ status: "disputed" });
    await expect(repository.requireAuthorized(RESOURCE_ID, publisher, "resolveWorkflowTask"))
      .rejects.toMatchObject({ code: "CHAIN_RESOURCE_FORBIDDEN" });
  });
});
