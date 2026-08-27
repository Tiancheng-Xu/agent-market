import { expect } from "chai";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deployWorkflowSepolia,
  readWorkflowDeploymentEnvironment,
  type WorkflowDeploymentRuntime,
} from "../scripts/deploy-workflow-sepolia";

const addresses = {
  deployer: "0x1000000000000000000000000000000000000001",
  ydToken: "0x2000000000000000000000000000000000000002",
  treasury: "0x3000000000000000000000000000000000000003",
  arbiter: "0x4000000000000000000000000000000000000004",
  receipt: "0x5000000000000000000000000000000000000005",
  escrow: "0x6000000000000000000000000000000000000006",
};

describe("Agent Market V3 Sepolia deployment", () => {
  it("requires explicit existing-token, treasury, and sole-arbiter addresses", () => {
    const config = readWorkflowDeploymentEnvironment({
      SEPOLIA_WORKFLOW_YD_TOKEN_ADDRESS: addresses.ydToken.toLowerCase(),
      PLATFORM_TREASURY_ADDRESS: addresses.treasury.toLowerCase(),
      PLATFORM_ARBITER_ADDRESS: addresses.arbiter.toLowerCase(),
    });

    expect(config).to.include({
      ydTokenAddress: addresses.ydToken,
      platformTreasury: addresses.treasury,
      platformArbiter: addresses.arbiter,
      outputPath: "docs/evidence/deployment/sepolia-workflow-v3.json",
    });
    expect(() => readWorkflowDeploymentEnvironment({
      SEPOLIA_WORKFLOW_YD_TOKEN_ADDRESS: addresses.ydToken,
      PLATFORM_TREASURY_ADDRESS: addresses.treasury,
    })).to.throw("PLATFORM_ARBITER_ADDRESS is required");
  });

  it("deploys only the receipt and workflow escrow, configures once, and writes a public-safe manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-market-workflow-deploy-"));
    const outputPath = join(directory, "workflow.json");
    const calls: Array<{ action: string; name?: string; args?: readonly unknown[] }> = [];
    const record = (address: string, byte: string, blockNumber: number) => ({
      address,
      transactionHash: `0x${byte.repeat(64)}`,
      blockNumber,
    });
    const runtime: WorkflowDeploymentRuntime = {
      networkName: "sepolia",
      chainId: 11155111,
      deployer: addresses.deployer,
      async verifyExistingYdToken(tokenAddress) {
        calls.push({ action: "verify-token", args: [tokenAddress] });
      },
      async deploy(name, args) {
        calls.push({ action: "deploy", name, args });
        return name === "TaskStakeReceipt"
          ? record(addresses.receipt, "a", 101)
          : record(addresses.escrow, "b", 102);
      },
      async configureEscrow(receiptAddress, escrowAddress) {
        calls.push({ action: "configure", args: [receiptAddress, escrowAddress] });
        return record(receiptAddress, "c", 103);
      },
    };

    const manifest = await deployWorkflowSepolia(runtime, {
      ydTokenAddress: addresses.ydToken,
      platformTreasury: addresses.treasury,
      platformArbiter: addresses.arbiter,
      outputPath,
      forbiddenValues: ["private-key-must-not-appear"],
    }, "2026-08-26T15:00:00.000Z");

    expect(calls).to.deep.equal([
      { action: "verify-token", args: [addresses.ydToken] },
      { action: "deploy", name: "TaskStakeReceipt", args: [] },
      { action: "deploy", name: "AgentMarketWorkflowEscrow", args: [addresses.ydToken, addresses.receipt, addresses.treasury, addresses.arbiter] },
      { action: "configure", args: [addresses.receipt, addresses.escrow] },
    ]);
    expect(manifest).to.deep.include({
      schemaVersion: "agent-market.workflow-deployment.v1",
      network: "sepolia",
      chainId: 11155111,
      ydTokenAddress: addresses.ydToken,
      platformTreasury: addresses.treasury,
      platformArbiter: addresses.arbiter,
    });
    expect(manifest.contracts.TaskStakeReceipt.address).to.equal(addresses.receipt);
    expect(manifest.contracts.AgentMarketWorkflowEscrow.address).to.equal(addresses.escrow);
    expect(manifest.setup.configureEscrow.transactionHash).to.equal(`0x${"c".repeat(64)}`);
    const serialized = await readFile(outputPath, "utf8");
    expect(serialized).not.to.contain("private-key-must-not-appear");
  });
});
