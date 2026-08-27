import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import { bindMethodArguments, contractForMethod, deriveChainResource, normalizeContractAllowlist } from "./policy";

const resource = deriveChainResource("018f0f9c-8b35-7f31-8f11-75f06c12a521");

describe("V3 workflow contract policy", () => {
  it("routes V3 methods only to the independent workflow escrow", () => {
    const contracts = normalizeContractAllowlist({
      token: Wallet.createRandom().address,
      escrow: Wallet.createRandom().address,
      committee: Wallet.createRandom().address,
      vault: Wallet.createRandom().address,
      workflowEscrow: Wallet.createRandom().address,
    });
    expect(contractForMethod("createWorkflowTask", contracts)).toBe(contracts.workflowEscrow);
    expect(contractForMethod("resolveWorkflowTask", contracts)).toBe(contracts.workflowEscrow);
    expect(contractForMethod("createTask", contracts)).toBe(contracts.escrow);
  });

  it("fails closed without a V3 address and binds approval to budget plus floor-rounded 6%", () => {
    const contracts = normalizeContractAllowlist({
      token: Wallet.createRandom().address,
      escrow: Wallet.createRandom().address,
      committee: Wallet.createRandom().address,
      vault: Wallet.createRandom().address,
      workflowEscrow: Wallet.createRandom().address,
    });
    expect(bindMethodArguments("approve", { target: "workflowEscrow" }, resource, contracts, {
      resourceId: "018f0f9c-8b35-7f31-8f11-75f06c12a521",
      publisherWallet: Wallet.createRandom().address,
      agentWallet: null,
      budgetAtomic: "101",
      status: "funding_pending",
    })).toMatchObject({ spender: contracts.workflowEscrow, amountAtomic: "107" });
    const { workflowEscrow: _removed, ...withoutV3 } = contracts;
    expect(() => contractForMethod("createWorkflowTask", withoutV3)).toThrow("CHAIN_WORKFLOW_ESCROW_UNAVAILABLE");
  });
});
