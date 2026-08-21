import { expect } from "chai";
import { ethers } from "hardhat";
import type { AgentMarketEscrow, ArbitrationCommittee, StakeYieldVault, YDToken } from "../typechain-types";

const YEAR = BigInt(365 * 24 * 60 * 60);

describe("Agent Market settlement", () => {
  async function fixture() {
    const [owner, publisher, agent, m1, m2, m3, m4, m5] = await ethers.getSigners();
    const token = (await ethers.deployContract("YDToken")) as unknown as YDToken;
    const committee = (await ethers.deployContract("ArbitrationCommittee", [[m1.address, m2.address, m3.address, m4.address, m5.address]])) as unknown as ArbitrationCommittee;
    const escrow = (await ethers.deployContract("AgentMarketEscrow", [await token.getAddress(), await committee.getAddress(), owner.address])) as unknown as AgentMarketEscrow;
    const vault = (await ethers.deployContract("StakeYieldVault", [await token.getAddress()])) as unknown as StakeYieldVault;
    await Promise.all([token.waitForDeployment(), committee.waitForDeployment(), escrow.waitForDeployment(), vault.waitForDeployment()]);
    await committee.setAuthorizedEscrow(await escrow.getAddress(), true);
    await token.connect(owner).faucet();
    await token.connect(publisher).faucet();
    await token.connect(agent).faucet();
    return { owner, publisher, agent, m1, m2, m3, m4, m5, token, committee, escrow, vault };
  }

  async function blockTimestamp(receipt: { blockNumber: number | null }): Promise<bigint> {
    if (receipt.blockNumber === null) throw new Error("transaction block is unavailable");
    return BigInt((await ethers.provider.getBlock(receipt.blockNumber))!.timestamp);
  }

  function expectedYield(budget: bigint, startedAt: bigint, settledAt: bigint): bigint {
    return budget * 6n * (settledAt - startedAt) / (100n * YEAR);
  }

  it("accrues exactly six percent linear yield in the staking vault", async () => {
    const { owner, agent, token, vault } = await fixture();
    const principal = ethers.parseEther("500");
    await token.connect(owner).approve(await vault.getAddress(), principal);
    await vault.connect(owner).fundRewardPool(principal);
    await token.connect(agent).approve(await vault.getAddress(), principal);
    await vault.connect(agent).stake(principal);
    await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    const earnedBeforeClaim = await vault.earned(agent.address);
    expect(earnedBeforeClaim).to.equal(ethers.parseEther("30"));
    const balanceBeforeClaim = await token.balanceOf(agent.address);
    await vault.connect(agent).claimYield();
    const claimed = (await token.balanceOf(agent.address)) - balanceBeforeClaim;
    expect(claimed).to.be.at.least(earnedBeforeClaim);
    expect(claimed - earnedBeforeClaim).to.be.at.most(principal * 6n * 2n / (100n * YEAR));
  });

  it("pays only budget yield to the agent and always sends the six percent bond to treasury", async () => {
    const { owner, publisher, agent, token, escrow } = await fixture();
    const taskId = ethers.id("task-success");
    const requestRef = ethers.id("request-success");
    const budget = ethers.parseEther("500");
    const bond = ethers.parseEther("30");
    await token.connect(owner).approve(await escrow.getAddress(), budget);
    await escrow.connect(owner).fundRewardPool(budget);
    await token.connect(publisher).approve(await escrow.getAddress(), budget);
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 40 * 24 * 60 * 60;
    await expect(escrow.connect(publisher).createTask(taskId, requestRef, budget, deadline)).to.emit(escrow, "TaskCreated").withArgs(taskId, requestRef, publisher.address, budget, deadline);
    expect((await escrow.tasks(taskId)).requestRef).to.equal(requestRef);
    await expect(escrow.connect(publisher).assignAgent(taskId, agent.address)).to.emit(escrow, "AgentAssigned").withArgs(taskId, requestRef, agent.address);
    await token.connect(agent).approve(await escrow.getAddress(), bond);
    const accepted = await escrow.connect(agent).acceptTask(taskId);
    const startedAt = await blockTimestamp((await accepted.wait())!);
    await expect(accepted).to.emit(escrow, "TaskAccepted").withArgs(taskId, requestRef, bond, startedAt);
    await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await expect(escrow.connect(agent).submitWork(taskId)).to.emit(escrow, "WorkSubmitted").withArgs(taskId, requestRef);
    const agentBefore = await token.balanceOf(agent.address);
    const treasuryBefore = await token.balanceOf(owner.address);
    const reserveBefore = await escrow.rewardReserve();
    const settled = await escrow.connect(publisher).acceptWork(taskId);
    const settledAt = await blockTimestamp((await settled.wait())!);
    const yieldPaid = expectedYield(budget, startedAt, settledAt);
    await expect(settled).to.emit(escrow, "TaskSettled").withArgs(taskId, requestRef, true, budget, bond, yieldPaid, 0);
    expect((await token.balanceOf(agent.address)) - agentBefore).to.equal(budget + yieldPaid);
    expect((await token.balanceOf(owner.address)) - treasuryBefore).to.equal(bond);
    expect(reserveBefore - await escrow.rewardReserve()).to.equal(yieldPaid);
    await expect(escrow.connect(publisher).acceptWork(taskId)).to.be.revertedWithCustomError(escrow, "InvalidState");
  });

  it("sends the bond to treasury when the committee rules for the publisher", async () => {
    const { owner, publisher, agent, m1, m2, token, committee, escrow } = await fixture();
    const taskId = ethers.id("task-publisher-wins");
    const requestRef = ethers.id("request-publisher-wins");
    const budget = ethers.parseEther("200");
    const bond = ethers.parseEther("12");
    await token.connect(owner).approve(await escrow.getAddress(), budget);
    await escrow.connect(owner).fundRewardPool(budget);
    await token.connect(publisher).approve(await escrow.getAddress(), budget);
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 7 * 24 * 60 * 60;
    await escrow.connect(publisher).createTask(taskId, requestRef, budget, deadline);
    await escrow.connect(publisher).assignAgent(taskId, agent.address);
    await token.connect(agent).approve(await escrow.getAddress(), bond);
    const accepted = await escrow.connect(agent).acceptTask(taskId);
    const startedAt = await blockTimestamp((await accepted.wait())!);
    await expect(escrow.connect(publisher).openDispute(taskId)).to.emit(escrow, "DisputeOpened").withArgs(taskId, requestRef);
    const publisherBefore = await token.balanceOf(publisher.address);
    const treasuryBefore = await token.balanceOf(owner.address);
    const reserveBefore = await escrow.rewardReserve();
    await committee.connect(m1).castVote(taskId, false);
    const resolution = await committee.connect(m2).castVote(taskId, false);
    const settledAt = await blockTimestamp((await resolution.wait())!);
    const yieldPaid = expectedYield(budget, startedAt, settledAt);
    await expect(resolution).to.emit(escrow, "TaskSettled").withArgs(taskId, requestRef, false, budget, bond, yieldPaid, 0);
    expect((await token.balanceOf(publisher.address)) - publisherBefore).to.equal(budget + yieldPaid);
    expect((await token.balanceOf(owner.address)) - treasuryBefore).to.equal(bond);
    expect(reserveBefore - await escrow.rewardReserve()).to.equal(yieldPaid);
    expect((await escrow.tasks(taskId)).state).to.equal(7);
  });

  it("propagates requestRef through an agent-winning dispute", async () => {
    const { owner, publisher, agent, m1, m2, token, committee, escrow } = await fixture();
    const taskId = ethers.id("task-dispute");
    const requestRef = ethers.id("request-dispute");
    const budget = ethers.parseEther("200");
    const bond = ethers.parseEther("12");
    await token.connect(owner).approve(await escrow.getAddress(), budget);
    await escrow.connect(owner).fundRewardPool(budget);
    await token.connect(publisher).approve(await escrow.getAddress(), budget);
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 7 * 24 * 60 * 60;
    await escrow.connect(publisher).createTask(taskId, requestRef, budget, deadline);
    await escrow.connect(publisher).assignAgent(taskId, agent.address);
    await token.connect(agent).approve(await escrow.getAddress(), bond);
    const accepted = await escrow.connect(agent).acceptTask(taskId);
    const startedAt = await blockTimestamp((await accepted.wait())!);
    await expect(accepted).to.emit(escrow, "TaskAccepted").withArgs(taskId, requestRef, bond, startedAt);
    await expect(escrow.connect(publisher).openDispute(taskId)).to.emit(escrow, "DisputeOpened").withArgs(taskId, requestRef);
    const caseData = await committee.getCase(taskId);
    expect(new Set(caseData.seats).size).to.equal(3);
    const agentBefore = await token.balanceOf(agent.address);
    const treasuryBefore = await token.balanceOf(owner.address);
    await committee.connect(m1).castVote(taskId, true);
    const resolution = await committee.connect(m2).castVote(taskId, true);
    const settledAt = await blockTimestamp((await resolution.wait())!);
    const yieldPaid = expectedYield(budget, startedAt, settledAt);
    await expect(resolution).to.emit(escrow, "TaskSettled").withArgs(taskId, requestRef, true, budget, bond, yieldPaid, 0);
    expect((await committee.getCase(taskId)).resolved).to.equal(true);
    expect((await token.balanceOf(agent.address)) - agentBefore).to.be.at.least(budget);
    expect((await token.balanceOf(owner.address)) - treasuryBefore).to.equal(bond);
    expect((await escrow.tasks(taskId)).state).to.equal(6);
  });

  it("rejects zero or reused request references and unselected callers", async () => {
    const { publisher, agent, m5, token, escrow } = await fixture();
    const budget = ethers.parseEther("100");
    const requestRef = ethers.id("request-unique");
    const firstTaskId = ethers.id("task-first");
    const secondTaskId = ethers.id("task-second");
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 7 * 24 * 60 * 60;
    await token.connect(publisher).approve(await escrow.getAddress(), budget);
    await expect(escrow.connect(publisher).createTask(firstTaskId, ethers.ZeroHash, budget, deadline)).to.be.revertedWithCustomError(escrow, "InvalidReference");
    await escrow.connect(publisher).createTask(firstTaskId, requestRef, budget, deadline);
    await escrow.connect(publisher).assignAgent(firstTaskId, agent.address);
    await expect(escrow.connect(publisher).acceptTask(firstTaskId)).to.be.revertedWithCustomError(escrow, "Unauthorized");
    await token.connect(agent).approve(await escrow.getAddress(), ethers.parseEther("6"));
    await escrow.connect(agent).acceptTask(firstTaskId);
    await expect(escrow.connect(publisher).submitWork(firstTaskId)).to.be.revertedWithCustomError(escrow, "Unauthorized");
    await token.connect(m5).faucet();
    await token.connect(m5).approve(await escrow.getAddress(), budget);
    await expect(escrow.connect(m5).createTask(secondTaskId, requestRef, budget, deadline)).to.be.revertedWithCustomError(escrow, "RequestRefAlreadyUsed").withArgs(requestRef);
  });
});
