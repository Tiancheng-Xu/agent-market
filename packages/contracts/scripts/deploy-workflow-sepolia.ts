import { ethers, network } from "hardhat";
import type { BaseContract, ContractTransactionResponse } from "ethers";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { SEPOLIA_CHAIN_ID, type ContractDeploymentRecord } from "../src/deployment-manifest";

export interface WorkflowDeploymentEnvironment {
  ydTokenAddress: string;
  platformTreasury: string;
  platformArbiter: string;
  outputPath: string;
  forbiddenValues: string[];
}

export interface WorkflowDeploymentRuntime {
  networkName: string;
  chainId: number | undefined;
  deployer: string;
  verifyExistingYdToken(tokenAddress: string): Promise<void>;
  deploy(name: "TaskStakeReceipt" | "AgentMarketWorkflowEscrow", args: readonly unknown[]): Promise<ContractDeploymentRecord>;
  configureEscrow(receiptAddress: string, escrowAddress: string): Promise<ContractDeploymentRecord>;
}

export interface WorkflowDeploymentManifestV1 {
  schemaVersion: "agent-market.workflow-deployment.v1";
  network: "sepolia";
  chainId: typeof SEPOLIA_CHAIN_ID;
  deployer: string;
  ydTokenAddress: string;
  platformTreasury: string;
  platformArbiter: string;
  deployedAt: string;
  contracts: {
    TaskStakeReceipt: ContractDeploymentRecord;
    AgentMarketWorkflowEscrow: ContractDeploymentRecord;
  };
  setup: {
    configureEscrow: ContractDeploymentRecord;
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function nonZeroAddress(value: string, name: string): string {
  const normalized = ethers.getAddress(value);
  if (normalized === ethers.ZeroAddress) throw new Error(`${name} must be non-zero`);
  return normalized;
}

export function readWorkflowDeploymentEnvironment(env: NodeJS.ProcessEnv): WorkflowDeploymentEnvironment {
  return {
    ydTokenAddress: nonZeroAddress(requiredEnv(env, "SEPOLIA_WORKFLOW_YD_TOKEN_ADDRESS"), "SEPOLIA_WORKFLOW_YD_TOKEN_ADDRESS"),
    platformTreasury: nonZeroAddress(requiredEnv(env, "PLATFORM_TREASURY_ADDRESS"), "PLATFORM_TREASURY_ADDRESS"),
    platformArbiter: nonZeroAddress(requiredEnv(env, "PLATFORM_ARBITER_ADDRESS"), "PLATFORM_ARBITER_ADDRESS"),
    outputPath: env.WORKFLOW_DEPLOYMENT_MANIFEST_PATH?.trim() || "docs/evidence/deployment/sepolia-workflow-v3.json",
    forbiddenValues: [env.SEPOLIA_RPC_URL ?? "", env.SEPOLIA_DEPLOYER_PRIVATE_KEY ?? "", env.SEPOLIA_ROLE_MNEMONIC ?? ""],
  };
}

export async function deployWorkflowSepolia(
  runtime: WorkflowDeploymentRuntime,
  config: WorkflowDeploymentEnvironment,
  deployedAt = new Date().toISOString(),
): Promise<WorkflowDeploymentManifestV1> {
  if (runtime.networkName !== "sepolia" || runtime.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`Deployment is restricted to Sepolia chain ${SEPOLIA_CHAIN_ID}`);
  }
  await runtime.verifyExistingYdToken(config.ydTokenAddress);
  const receipt = await runtime.deploy("TaskStakeReceipt", []);
  const escrow = await runtime.deploy("AgentMarketWorkflowEscrow", [
    config.ydTokenAddress,
    receipt.address,
    config.platformTreasury,
    config.platformArbiter,
  ]);
  const configureEscrow = await runtime.configureEscrow(receipt.address, escrow.address);
  const manifest: WorkflowDeploymentManifestV1 = {
    schemaVersion: "agent-market.workflow-deployment.v1",
    network: "sepolia",
    chainId: SEPOLIA_CHAIN_ID,
    deployer: ethers.getAddress(runtime.deployer),
    ydTokenAddress: ethers.getAddress(config.ydTokenAddress),
    platformTreasury: ethers.getAddress(config.platformTreasury),
    platformArbiter: ethers.getAddress(config.platformArbiter),
    deployedAt: new Date(deployedAt).toISOString(),
    contracts: { TaskStakeReceipt: receipt, AgentMarketWorkflowEscrow: escrow },
    setup: { configureEscrow },
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const value of config.forbiddenValues.map((item) => item.trim()).filter((item) => item.length >= 4)) {
    if (serialized.includes(value)) throw new Error("Workflow deployment manifest contains a forbidden environment value");
  }
  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, serialized, { encoding: "utf8", mode: 0o600 });
  return manifest;
}

export function formatWorkflowDeploymentFailure(_error: unknown): string {
  return "WORKFLOW_DEPLOYMENT_FAILED";
}

async function deploymentRecord(contract: BaseContract): Promise<ContractDeploymentRecord> {
  await contract.waitForDeployment();
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error("Deployment transaction is unavailable");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Deployment receipt is unavailable");
  return { address: await contract.getAddress(), transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function configurationRecord(address: string, transaction: ContractTransactionResponse): Promise<ContractDeploymentRecord> {
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Receipt escrow configuration failed");
  return { address: ethers.getAddress(address), transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function main(): Promise<void> {
  const config = readWorkflowDeploymentEnvironment(process.env);
  if (network.name !== "sepolia" || network.config.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`Deployment is restricted to Sepolia chain ${SEPOLIA_CHAIN_ID}`);
  }
  const [deployer] = await ethers.getSigners();
  let receiptContract: BaseContract | undefined;
  const runtime: WorkflowDeploymentRuntime = {
    networkName: network.name,
    chainId: network.config.chainId,
    deployer: deployer.address,
    async verifyExistingYdToken(tokenAddress) {
      const code = await ethers.provider.getCode(tokenAddress);
      if (code === "0x") throw new Error("Existing YDToken contract is unavailable");
      const token = await ethers.getContractAt("YDToken", tokenAddress);
      await token.totalSupply();
    },
    async deploy(name, args) {
      const contract = await ethers.deployContract(name, [...args]);
      if (name === "TaskStakeReceipt") receiptContract = contract;
      return deploymentRecord(contract);
    },
    async configureEscrow(receiptAddress, escrowAddress) {
      if (!receiptContract) throw new Error("TaskStakeReceipt deployment is unavailable");
      const receipt = receiptContract as unknown as BaseContract & {
        configureEscrow(address: string): Promise<ContractTransactionResponse>;
      };
      return configurationRecord(receiptAddress, await receipt.configureEscrow(escrowAddress));
    },
  };
  const manifest = await deployWorkflowSepolia(runtime, config);
  process.stdout.write(`Workflow deployment manifest written to ${config.outputPath}; block ${manifest.contracts.AgentMarketWorkflowEscrow.blockNumber}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${formatWorkflowDeploymentFailure(error)}\n`);
    process.exitCode = 1;
  });
}
