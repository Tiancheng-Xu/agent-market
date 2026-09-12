import { expect } from "chai";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const id = (n: number) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const task = id(100);
const version = ethers.id("exploration-policy-v1");
const evidence = ethers.id("qualified-pool-snapshot");
const pool = [
  { agentId: id(1), weight: 1, eligible: true },
  { agentId: id(2), weight: 0, eligible: false },
  { agentId: id(3), weight: 3, eligible: true },
];

async function fixture() {
  const [owner, other] = await ethers.getSigners();
  const solc = require(require.resolve("solc", { paths: [require.resolve("hardhat")] }));
  const source = readFileSync(join(__dirname, "fixtures/VRFSelectionCoordinatorMock.sol"), "utf8");
  const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "Mock.sol": { content: source } }, settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } } })));
  const artifact = output.contracts["Mock.sol"].VRFSelectionCoordinatorMock;
  const coordinator: any = await new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, owner).deploy();
  const selector: any = await ethers.deployContract("VRFExplorationSelector", [await coordinator.getAddress(), owner.address, id(42), 123, 3, 150000, false, 3600]);
  return { owner, other, coordinator, selector };
}

async function requested() {
  const f = await fixture();
  await f.selector.freeze(task, version, evidence, pool);
  await f.selector.requestSelection(task);
  return f;
}

describe("VRFExplorationSelector", () => {
  it("freezes an independently reproducible domain-separated full snapshot", async () => {
    const { selector } = await fixture();
    await selector.freeze(task, version, evidence, pool);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const expected = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32", "bytes32", "bytes32", "tuple(bytes32 agentId,uint32 weight,bool eligible)[]"],
      [ethers.id("AGENT_MARKET_EXPLORATION_V1"), chainId, await selector.getAddress(), task, version, evidence, pool],
    ));
    expect((await selector.selections(task)).commitment).to.equal(expected);
    expect((await selector.selections(task)).totalWeight).to.equal(4);
    expect((await selector.getPool(task)).length).to.equal(3);
    await expect(selector.freeze(task, id(999), evidence, pool)).to.be.revertedWithCustomError(selector, "AlreadyFrozen");
  });

  it("restricts freezing and callbacks but lets anyone request a frozen draw", async () => {
    const { selector, other } = await fixture();
    await expect(selector.connect(other).freeze(task, version, evidence, pool)).to.be.revertedWithCustomError(selector, "Unauthorized");
    await selector.freeze(task, version, evidence, pool);
    await selector.connect(other).requestSelection(task);
    await expect(selector.connect(other).rawFulfillRandomWords(1, [0])).to.be.revertedWithCustomError(selector, "OnlyCoordinator");
    await expect(selector.rawFulfillRandomWords(1, [0])).to.be.revertedWithCustomError(selector, "OnlyCoordinator");
  });

  it("sends the official v2.5 tuple and ExtraArgsV1 encoding", async () => {
    const { selector, coordinator } = await requested();
    const [req] = ethers.AbiCoder.defaultAbiCoder().decode(["tuple(bytes32 keyHash,uint256 subId,uint16 requestConfirmations,uint32 callbackGasLimit,uint32 numWords,bytes extraArgs)"], await coordinator.lastRequest());
    expect(req.keyHash).to.equal(id(42));
    expect(req.subId).to.equal(123);
    expect(req.requestConfirmations).to.equal(3);
    expect(req.callbackGasLimit).to.equal(150000);
    expect(req.numWords).to.equal(1);
    expect(req.extraArgs).to.equal(ethers.concat([ethers.id("VRF ExtraArgsV1").slice(0, 10), ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [false])]));
    expect((await selector.selections(task)).requestId).to.equal(1);
  });

  for (const [word, winner] of [[0, 1], [1, 3], [2, 3], [3, 3], [4, 1]]) {
    it(`selects eligible weighted interval for word ${word}`, async () => {
      const { selector, coordinator, other } = await requested();
      await coordinator.fulfill(await selector.getAddress(), 1, [word]);
      await selector.connect(other).finalize(task);
      expect((await selector.selections(task)).selectedAgent).to.equal(id(winner));
      await expect(selector.finalize(task)).to.be.revertedWithCustomError(selector, "InvalidState");
    });
  }

  it("matches out-of-order callbacks and ignores duplicate/unknown/malformed callbacks", async () => {
    const { selector, coordinator } = await requested();
    await selector.freeze(id(101), version, evidence, pool);
    await selector.requestSelection(id(101));
    const address = await selector.getAddress();
    await coordinator.fulfill(address, 999, [1]);
    await coordinator.fulfill(address, 1, []);
    await coordinator.fulfill(address, 1, [1, 2]);
    expect((await selector.selections(task)).state).to.equal(2);
    await coordinator.fulfill(address, 2, [0]);
    await coordinator.fulfill(address, 1, [1]);
    await coordinator.fulfill(address, 1, [0]);
    await selector.finalize(task);
    await selector.finalize(id(101));
    expect((await selector.selections(task)).selectedAgent).to.equal(id(3));
    expect((await selector.selections(id(101))).selectedAgent).to.equal(id(1));
    await coordinator.fulfill(address, 1, [0]);
    expect((await selector.selections(task)).selectedAgent).to.equal(id(3));
  });

  it("never rerolls or discards a late result after timeout", async () => {
    const { selector, coordinator } = await requested();
    expect(await selector.isOverdue(task)).to.equal(false);
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    expect(await selector.isOverdue(task)).to.equal(true);
    await expect(selector.requestSelection(task)).to.be.revertedWithCustomError(selector, "InvalidState");
    await expect(selector.freeze(task, id(888), evidence, pool)).to.be.revertedWithCustomError(selector, "AlreadyFrozen");
    await expect(selector.finalize(task)).to.be.revertedWithCustomError(selector, "InvalidState");
    await coordinator.fulfill(await selector.getAddress(), 1, [3]);
    await selector.finalize(task);
    expect((await selector.selections(task)).selectedAgent).to.equal(id(3));
    expect(await selector.isOverdue(task)).to.equal(false);
    await expect(selector.requestSelection(task)).to.be.revertedWithCustomError(selector, "InvalidState");
  });

  it("rolls back failed requests and rejects colliding or zero request IDs", async () => {
    const { selector, coordinator } = await fixture();
    await selector.freeze(task, version, evidence, pool);
    await coordinator.setFail(true);
    await expect(selector.requestSelection(task)).to.be.revertedWith("unavailable");
    expect((await selector.selections(task)).state).to.equal(1);
    await coordinator.setFail(false);
    await coordinator.setNextId(0);
    await expect(selector.requestSelection(task)).to.be.revertedWithCustomError(selector, "InvalidRequestId");
    await coordinator.setNextId(1);
    await selector.requestSelection(task);
    await selector.freeze(id(101), version, evidence, pool);
    await coordinator.setNextId(1);
    await expect(selector.requestSelection(id(101))).to.be.revertedWithCustomError(selector, "InvalidRequestId");
    expect((await selector.selections(id(101))).state).to.equal(1);
    await coordinator.fulfill(await selector.getAddress(), 1, [0]);
    await selector.finalize(task);
    expect((await selector.selections(task)).selectedAgent).to.equal(id(1));
  });

  it("rejects invalid identities, versions, eligibility and candidate order", async () => {
    const { selector } = await fixture();
    for (const args of [
      [ethers.ZeroHash, version, evidence, pool], [task, ethers.ZeroHash, evidence, pool],
      [task, version, ethers.ZeroHash, pool], [task, version, evidence, []],
      [task, version, evidence, [pool[0], pool[0]]], [task, version, evidence, [...pool].reverse()],
      [task, version, evidence, [{ agentId: ethers.ZeroHash, weight: 1, eligible: true }]],
      [task, version, evidence, [{ agentId: id(1), weight: 0, eligible: true }]],
      [task, version, evidence, [{ agentId: id(1), weight: 1, eligible: false }]],
      [task, version, evidence, [pool[1]]],
      [task, version, evidence, Array.from({ length: 129 }, (_, n) => ({ agentId: id(n + 1), weight: 1, eligible: true }))],
    ]) await expect(selector.freeze(...args)).to.be.revertedWithCustomError(selector, "InvalidPool");
    await expect(selector.requestSelection(task)).to.be.revertedWithCustomError(selector, "InvalidState");
    await expect(selector.finalize(task)).to.be.revertedWithCustomError(selector, "InvalidState");
  });

  it("handles maximum pool/weights within the fixed callback gas budget", async () => {
    const { selector, coordinator } = await fixture();
    const large = Array.from({ length: 128 }, (_, n) => ({ agentId: id(n + 1), weight: 4294967295, eligible: true }));
    await selector.freeze(task, version, evidence, large);
    await selector.requestSelection(task);
    await coordinator.fulfill(await selector.getAddress(), 1, [128n * 4294967295n - 1n]);
    await selector.finalize(task);
    expect((await selector.selections(task)).selectedAgent).to.equal(id(128));
  });
});
