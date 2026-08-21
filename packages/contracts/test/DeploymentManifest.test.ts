import { expect } from "chai";
import { artifacts } from "hardhat";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeploymentManifest, SEPOLIA_CHAIN_ID, writeDeploymentManifest, type DeploymentManifestInput } from "../src/deployment-manifest";
import { formatDeploymentFailure, runSepoliaDeployment, type DeploymentRuntime } from "../scripts/deploy-sepolia";

const addresses = [1, 2, 3, 4, 5, 6, 7].map((value) => `0x${value.toString(16).padStart(40, "0")}`);
const transactionHashes = [1, 2, 3, 4].map((value) => `0x${value.toString(16).padStart(64, "0")}`);

async function expectRejected(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
    expect.fail("Expected promise to reject");
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).to.include(message);
  }
}

function validInput(): DeploymentManifestInput {
  return {
    chainId: SEPOLIA_CHAIN_ID,
    deployer: addresses[0],
    platformTreasury: addresses[1],
    deployedAt: "2026-08-21T12:00:00.000Z",
    contracts: {
      YDToken: { address: addresses[2], transactionHash: transactionHashes[0], blockNumber: 100 },
      ArbitrationCommittee: { address: addresses[3], transactionHash: transactionHashes[1], blockNumber: 101 },
      AgentMarketEscrow: { address: addresses[4], transactionHash: transactionHashes[2], blockNumber: 102 },
      StakeYieldVault: { address: addresses[5], transactionHash: transactionHashes[3], blockNumber: 103 },
    },
  };
}

function validEnv(outputPath: string): NodeJS.ProcessEnv {
  return {
    ARBITRATION_MEMBER_ADDRESSES: addresses.slice(0, 5).join(","),
    PLATFORM_TREASURY_ADDRESS: addresses[6],
    DEPLOYMENT_MANIFEST_PATH: outputPath,
    SEPOLIA_RPC_URL: "https://rpc.example/secret-value",
    SEPOLIA_DEPLOYER_PRIVATE_KEY: "0xprivate-secret-value",
  };
}

describe("Sepolia deployment manifest", () => {
  it("normalizes a complete four-contract manifest without secret material", () => {
    const manifest = createDeploymentManifest(validInput());
    expect(manifest.schemaVersion).to.equal(1);
    expect(manifest.chainId).to.equal(11155111);
    expect(Object.keys(manifest.contracts)).to.deep.equal(["YDToken", "ArbitrationCommittee", "AgentMarketEscrow", "StakeYieldVault"]);
  });

  it("rejects wrong-chain, unknown, duplicate, and malformed evidence", () => {
    expect(() => createDeploymentManifest({ ...validInput(), chainId: 1 })).to.throw("Expected Sepolia chain");
    expect(() => createDeploymentManifest({ ...validInput(), rpcUrl: "https://forbidden.example" })).to.throw("unknown fields");
    const duplicated = validInput();
    duplicated.contracts.StakeYieldVault.address = duplicated.contracts.YDToken.address;
    expect(() => createDeploymentManifest(duplicated)).to.throw("addresses must be unique");
    const malformed = validInput();
    malformed.contracts.YDToken.transactionHash = "0x1234";
    expect(() => createDeploymentManifest(malformed)).to.throw("transactionHash must be 32 bytes");
  });

  it("rebuilds an allowlisted object before writing and rejects forbidden values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-market-manifest-"));
    const output = join(directory, "manifest.json");
    try {
      await expectRejected(writeDeploymentManifest(output, { ...validInput(), metadata: { endpoint: "secret" } }), "unknown fields");
      await expectRejected(writeDeploymentManifest(output, validInput(), [addresses[0]]), "forbidden environment value");
      await writeDeploymentManifest(output, validInput(), ["https://rpc.example/secret-value"]);
      expect(await readFile(output, "utf8")).not.to.include("rpc.example");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates every environment value before deploy and preserves deployment order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-market-deploy-"));
    const calls: string[] = [];
    let nextRecord = 0;
    const runtime: DeploymentRuntime = {
      networkName: "sepolia",
      chainId: SEPOLIA_CHAIN_ID,
      deployer: addresses[0],
      async deploy(name) {
        calls.push(name);
        const index = nextRecord++;
        return { address: addresses[index + 2], transactionHash: transactionHashes[index], blockNumber: index + 100 };
      },
      async authorizeEscrow() { calls.push("authorize"); },
    };
    try {
      const badEnv = validEnv(join(directory, "bad.json"));
      badEnv.ARBITRATION_MEMBER_ADDRESSES = Array(5).fill(addresses[2]).join(",");
      await expectRejected(runSepoliaDeployment(runtime, badEnv), "five unique addresses");
      expect(calls).to.deep.equal([]);
      await runSepoliaDeployment(runtime, validEnv(join(directory, "manifest.json")), "2026-08-21T12:00:00.000Z");
      expect(calls).to.deep.equal(["YDToken", "ArbitrationCommittee", "AgentMarketEscrow", "StakeYieldVault", "authorize"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses a stable redacted failure and exposes the expected ABI", async () => {
    expect(formatDeploymentFailure(new Error("https://rpc.example/private-key"))).to.equal("DEPLOYMENT_FAILED");
    const artifact = await artifacts.readArtifact("AgentMarketEscrow");
    const constructor = artifact.abi.find((item) => item.type === "constructor");
    const createTask = artifact.abi.find((item) => item.type === "function" && item.name === "createTask");
    const settled = artifact.abi.find((item) => item.type === "event" && item.name === "TaskSettled");
    expect(constructor?.inputs?.map((input: { type: string }) => input.type)).to.deep.equal(["address", "address", "address"]);
    expect(createTask?.inputs?.map((input: { type: string }) => input.type)).to.deep.equal(["bytes32", "bytes32", "uint256", "uint64"]);
    expect(settled?.inputs?.[1]).to.include({ name: "requestRef", type: "bytes32", indexed: true });
  });
});
