import { expect } from "chai";
import { ethers } from "hardhat";

import { createDeploymentManifest } from "../src/deployment-manifest";
import { createSepoliaClosureEvidence, deriveRoleAddresses, type ScenarioEvidence } from "../src/sepolia-closure";

const phrase = "test test test test test test test test test test test junk";
const hashes = [1, 2, 3, 4].map((value) => `0x${value.toString(16).padStart(64, "0")}`);
const tx = (action: string, index = 0) => ({ action, transactionHash: hashes[index]!, blockNumber: 100 + index, status: 1 as const });

function scenario(agentWins: boolean): ScenarioEvidence {
  return {
    taskId: ethers.id(`task:${agentWins}`),
    requestRef: ethers.id(`request:${agentWins}`),
    finalState: agentWins ? "SETTLED" : "REFUNDED",
    agentWins,
    budgetAtomic: "100000000000000000000",
    bondPaidToPlatformAtomic: "6000000000000000000",
    yieldPaidAtomic: "1",
    transactions: [tx(agentWins ? "normal" : "dispute")],
  };
}

describe("Sepolia closure evidence", () => {
  it("derives nine stable and unique role addresses", () => {
    const first = deriveRoleAddresses(phrase);
    const second = deriveRoleAddresses(phrase);
    expect(first).to.deep.equal(second);
    const addresses = [first.deployer, ...first.committee, first.publisher, first.agent, first.treasury];
    expect(new Set(addresses).size).to.equal(9);
  });

  it("builds allowlisted closure evidence and rejects embedded secrets", () => {
    const roles = deriveRoleAddresses(phrase);
    const deployment = createDeploymentManifest({
      chainId: 11155111,
      deployer: roles.deployer,
      platformTreasury: roles.treasury,
      deployedAt: "2026-08-21T12:00:00.000Z",
      contracts: {
        YDToken: { address: roles.committee[0]!, transactionHash: hashes[0]!, blockNumber: 100 },
        ArbitrationCommittee: { address: roles.committee[1]!, transactionHash: hashes[1]!, blockNumber: 101 },
        AgentMarketEscrow: { address: roles.committee[2]!, transactionHash: hashes[2]!, blockNumber: 102 },
        StakeYieldVault: { address: roles.committee[3]!, transactionHash: hashes[3]!, blockNumber: 103 },
      },
    });
    const input = {
      capturedAt: "2026-08-21T12:30:00.000Z",
      deployment,
      roles,
      normalSettlement: scenario(true),
      disputeSettlement: scenario(false),
      staking: { principalAtomic: "50000000000000000000", finalPrincipalAtomic: "0", transactions: [tx("stake", 1)] },
      rpcReadback: { checkedTransactions: 3, allReceiptsSuccessful: true },
    };
    const evidence = createSepoliaClosureEvidence(input, ["https://rpc.secret.example"]);
    expect(evidence.status).to.equal("rpc-verified-blockscout-pending");
    expect(JSON.stringify(evidence)).not.to.contain("rpc.secret");
    expect(() => createSepoliaClosureEvidence(input, [roles.deployer])).to.throw("CONTAINS_SECRET");
  });
});
