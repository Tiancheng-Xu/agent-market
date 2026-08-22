import { getAddress, isAddress, isHexString } from "ethers";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SEPOLIA_CHAIN_ID = 11155111;
export const DEPLOYED_CONTRACT_NAMES = ["YDToken", "ArbitrationCommittee", "AgentMarketEscrow", "StakeYieldVault"] as const;
export type DeployedContractName = (typeof DEPLOYED_CONTRACT_NAMES)[number];

export interface ContractDeploymentRecord {
  address: string;
  transactionHash: string;
  blockNumber: number;
}

export interface DeploymentManifestInput {
  chainId: number;
  deployer: string;
  platformTreasury: string;
  deployedAt: string;
  contracts: Record<DeployedContractName, ContractDeploymentRecord>;
}

export interface DeploymentManifestV1 extends DeploymentManifestInput {
  schemaVersion: 1;
  network: "sepolia";
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as UnknownRecord;
}

function assertExactKeys(record: UnknownRecord, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
  const missing = allowed.filter((key) => !(key in record));
  if (missing.length) throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
}

function normalizeAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAddress(value)) throw new Error(`${label} must be a valid address`);
  return getAddress(value);
}

function normalizeDeployment(name: DeployedContractName, value: unknown): ContractDeploymentRecord {
  const record = asRecord(value, name);
  assertExactKeys(record, ["address", "transactionHash", "blockNumber"], name);
  if (typeof record.transactionHash !== "string" || !isHexString(record.transactionHash, 32)) {
    throw new Error(`${name} transactionHash must be 32 bytes`);
  }
  if (!Number.isSafeInteger(record.blockNumber) || Number(record.blockNumber) <= 0) {
    throw new Error(`${name} blockNumber must be positive`);
  }
  return {
    address: normalizeAddress(record.address, `${name} address`),
    transactionHash: record.transactionHash,
    blockNumber: Number(record.blockNumber),
  };
}

export function createDeploymentManifest(input: unknown): DeploymentManifestV1 {
  const root = asRecord(input, "manifest");
  assertExactKeys(root, ["chainId", "deployer", "platformTreasury", "deployedAt", "contracts"], "manifest");
  if (root.chainId !== SEPOLIA_CHAIN_ID) throw new Error(`Expected Sepolia chain ${SEPOLIA_CHAIN_ID}`);
  if (typeof root.deployedAt !== "string" || Number.isNaN(Date.parse(root.deployedAt))) {
    throw new Error("deployedAt must be an ISO timestamp");
  }
  const rawContracts = asRecord(root.contracts, "contracts");
  assertExactKeys(rawContracts, DEPLOYED_CONTRACT_NAMES, "contracts");
  const contracts = Object.fromEntries(
    DEPLOYED_CONTRACT_NAMES.map((name) => [name, normalizeDeployment(name, rawContracts[name])]),
  ) as Record<DeployedContractName, ContractDeploymentRecord>;
  if (new Set(Object.values(contracts).map((record) => record.address)).size !== DEPLOYED_CONTRACT_NAMES.length) {
    throw new Error("Contract deployment addresses must be unique");
  }
  return {
    schemaVersion: 1,
    network: "sepolia",
    chainId: SEPOLIA_CHAIN_ID,
    deployer: normalizeAddress(root.deployer, "deployer"),
    platformTreasury: normalizeAddress(root.platformTreasury, "platformTreasury"),
    deployedAt: new Date(root.deployedAt).toISOString(),
    contracts,
  };
}

export async function writeDeploymentManifest(
  path: string,
  input: unknown,
  forbiddenValues: readonly string[] = [],
): Promise<DeploymentManifestV1> {
  const candidate = asRecord(input, "manifest");
  let manifest: DeploymentManifestV1;
  if ("schemaVersion" in candidate || "network" in candidate) {
    assertExactKeys(
      candidate,
      ["schemaVersion", "network", "chainId", "deployer", "platformTreasury", "deployedAt", "contracts"],
      "manifest",
    );
    if (candidate.schemaVersion !== 1 || candidate.network !== "sepolia") {
      throw new Error("Deployment manifest version or network is invalid");
    }
    manifest = createDeploymentManifest({
      chainId: candidate.chainId,
      deployer: candidate.deployer,
      platformTreasury: candidate.platformTreasury,
      deployedAt: candidate.deployedAt,
      contracts: candidate.contracts,
    });
  } else {
    manifest = createDeploymentManifest(candidate);
  }
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const value of forbiddenValues.map((item) => item.trim()).filter((item) => item.length >= 4)) {
    if (serialized.includes(value)) throw new Error("Deployment manifest contains a forbidden environment value");
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, { encoding: "utf8", mode: 0o600 });
  return manifest;
}
