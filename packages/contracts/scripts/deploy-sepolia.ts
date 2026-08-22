import { ethers, network } from "hardhat";
import type { BaseContract, ContractTransactionResponse } from "ethers";
import {
  createDeploymentManifest,
  SEPOLIA_CHAIN_ID,
  writeDeploymentManifest,
  type ContractDeploymentRecord,
  type DeploymentManifestV1,
} from "../src/deployment-manifest";

export interface DeploymentEnvironment {
  committeeMembers: string[];
  platformTreasury: string;
  outputPath: string;
  forbiddenValues: string[];
}

export interface DeploymentRuntime {
  networkName: string;
  chainId: number | undefined;
  deployer: string;
  deploy(name: string, args: readonly unknown[]): Promise<ContractDeploymentRecord>;
  authorizeEscrow(committeeAddress: string, escrowAddress: string): Promise<void>;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function readDeploymentEnvironment(env: NodeJS.ProcessEnv): DeploymentEnvironment {
  const rawMembers = requiredEnv(env, "ARBITRATION_MEMBER_ADDRESSES").split(",").map((value) => value.trim());
  if (rawMembers.some((address) => !ethers.isAddress(address) || address === ethers.ZeroAddress)) {
    throw new Error("ARBITRATION_MEMBER_ADDRESSES must contain valid non-zero addresses");
  }
  const committeeMembers = [...new Set(rawMembers.map(ethers.getAddress))];
  if (committeeMembers.length < 5) throw new Error("ARBITRATION_MEMBER_ADDRESSES must contain five unique addresses");
  const platformTreasury = ethers.getAddress(requiredEnv(env, "PLATFORM_TREASURY_ADDRESS"));
  if (platformTreasury === ethers.ZeroAddress) throw new Error("PLATFORM_TREASURY_ADDRESS must be non-zero");
  return {
    committeeMembers,
    platformTreasury,
    outputPath: env.DEPLOYMENT_MANIFEST_PATH?.trim() || "docs/evidence/deployment/sepolia-contracts.json",
    forbiddenValues: [env.SEPOLIA_RPC_URL ?? "", env.SEPOLIA_DEPLOYER_PRIVATE_KEY ?? ""],
  };
}

export function formatDeploymentFailure(_error: unknown): string {
  return "DEPLOYMENT_FAILED";
}

export async function deploySepolia(
  runtime: DeploymentRuntime,
  config: DeploymentEnvironment,
  deployedAt = new Date().toISOString(),
): Promise<DeploymentManifestV1> {
  if (runtime.networkName !== "sepolia" || runtime.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`Deployment is restricted to Sepolia chain ${SEPOLIA_CHAIN_ID}`);
  }
  const token = await runtime.deploy("YDToken", []);
  const committee = await runtime.deploy("ArbitrationCommittee", [config.committeeMembers]);
  const escrow = await runtime.deploy("AgentMarketEscrow", [token.address, committee.address, config.platformTreasury]);
  const vault = await runtime.deploy("StakeYieldVault", [token.address]);
  await runtime.authorizeEscrow(committee.address, escrow.address);
  const manifest = createDeploymentManifest({
    chainId: SEPOLIA_CHAIN_ID,
    deployer: runtime.deployer,
    platformTreasury: config.platformTreasury,
    deployedAt,
    contracts: { YDToken: token, ArbitrationCommittee: committee, AgentMarketEscrow: escrow, StakeYieldVault: vault },
  });
  await writeDeploymentManifest(config.outputPath, manifest, config.forbiddenValues);
  return manifest;
}

export async function runSepoliaDeployment(
  runtime: DeploymentRuntime,
  env: NodeJS.ProcessEnv,
  deployedAt?: string,
): Promise<DeploymentManifestV1> {
  return deploySepolia(runtime, readDeploymentEnvironment(env), deployedAt);
}

async function deploymentRecord(contract: BaseContract): Promise<ContractDeploymentRecord> {
  await contract.waitForDeployment();
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error("Deployment transaction is unavailable");
  const receipt = await transaction.wait();
  if (!receipt) throw new Error("Deployment receipt is unavailable");
  return { address: await contract.getAddress(), transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function waitForConfiguration(transaction: ContractTransactionResponse): Promise<void> {
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Escrow authorization failed");
}

async function main(): Promise<void> {
  const config = readDeploymentEnvironment(process.env);
  if (network.name !== "sepolia" || network.config.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`Deployment is restricted to Sepolia chain ${SEPOLIA_CHAIN_ID}`);
  }
  const [deployer] = await ethers.getSigners();
  let committeeContract: BaseContract | undefined;
  const runtime: DeploymentRuntime = {
    networkName: network.name,
    chainId: network.config.chainId,
    deployer: deployer.address,
    async deploy(name, args) {
      const contract = await ethers.deployContract(name, [...args]);
      if (name === "ArbitrationCommittee") committeeContract = contract;
      return deploymentRecord(contract);
    },
    async authorizeEscrow(_committeeAddress, escrowAddress) {
      if (!committeeContract) throw new Error("Committee deployment is unavailable");
      const committee = committeeContract as unknown as BaseContract & {
        setAuthorizedEscrow(address: string, authorized: boolean): Promise<ContractTransactionResponse>;
      };
      await waitForConfiguration(await committee.setAuthorizedEscrow(escrowAddress, true));
    },
  };
  const manifest = await deploySepolia(runtime, config);
  process.stdout.write(`Sepolia deployment manifest written to ${config.outputPath}; block ${manifest.contracts.StakeYieldVault.blockNumber}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${formatDeploymentFailure(error)}\n`);
    process.exitCode = 1;
  });
}
