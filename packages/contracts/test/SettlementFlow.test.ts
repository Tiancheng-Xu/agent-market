import { expect } from "chai";
import { ethers } from "hardhat";
import type { AgentMarketEscrow, ArbitrationCommittee, StakeYieldVault, YDToken } from "../typechain-types";

describe("Agent Market settlement", () => {
  async function fixture() {
    const [owner, publisher, agent, m1, m2, m3, m4, m5] = await ethers.getSigners();
    const token = (await ethers.deployContract("YDToken")) as unknown as YDToken;
    const committee = (await ethers.deployContract("ArbitrationCommittee", [[m1.address, m2.address, m3.address, m4.address, m5.address]])) as unknown as ArbitrationCommittee;
    const escrow = (await ethers.deployContract("AgentMarketEscrow", [await token.getAddress(), await committee.getAddress()])) as unknown as AgentMarketEscrow;
    const vault = (await ethers.deployContract("StakeYieldVault", [await token.getAddress()])) as unknown as StakeYieldVault;
    await Promise.all([token.waitForDeployment(), committee.waitForDeployment(), escrow.waitForDeployment(), vault.waitForDeployment()]);
    await committee.setAuthorizedEscrow(await escrow.getAddress(), true);
    await token.connect(owner).faucet();
    await token.connect(publisher).faucet();
    await token.connect(agent).faucet();
    return { owner, publisher, agent, m1, m2, m3, m4, m5, token, committee, escrow, vault };
  }

  it("accrues exactly six percent linear yield in the staking vault", async () => {
    const { owner, agent, token, vault } = await fixture();
    const principal = ethers.parseEther("500");
    await token.connect(owner).approve(await vault.getAddress(), ethers.parseEther("500"));
    await vault.connect(owner).fundRewardPool(ethers.parseEther("500"));
    await token.connect(agent).approve(await vault.getAddress(), principal);
    await vault.connect(agent).stake(principal);
    await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    const earnedBeforeClaim = await vault.earned(agent.address);
    expect(earnedBeforeClaim).to.equal(ethers.parseEther("30"));
    const balanceBeforeClaim = await token.balanceOf(agent.address);
    await vault.connect(agent).claimYield();
    const claimed = (await token.balanceOf(agent.address)) - balanceBeforeClaim;
    const twoSecondTolerance = principal * 6n * 2n / (100n * BigInt(365 * 24 * 60 * 60));
    expect(claimed).to.be.at.least(earnedBeforeClaim);
    expect(claimed - earnedBeforeClaim).to.be.at.most(twoSecondTolerance);
  });

  it("settles budget, six percent bond, and funded linear yield exactly once", async () => {
    const { owner, publisher, agent, token, escrow } = await fixture();
    const taskId = ethers.id("task-success");
    const budget = ethers.parseEther("500");
    await token.connect(owner).approve(await escrow.getAddress(), ethers.parseEther("500"));
    await escrow.connect(owner).fundRewardPool(ethers.parseEther("500"));
    await token.connect(publisher).approve(await escrow.getAddress(), budget);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await escrow.connect(publisher).createTask(taskId, budget, now + 40 * 24 * 60 * 60);
    await escrow.connect(publisher).assignAgent(taskId, agent.address);
    const bond = ethers.parseEther("30");
    await token.connect(agent).approve(await escrow.getAddress(), bond);
    await escrow.connect(agent).acceptTask(taskId);
    await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await escrow.connect(agent).submitWork(taskId);
    await escrow.connect(publisher).acceptWork(taskId);
    const settled = await escrow.tasks(taskId);
    expect(settled.state).to.equal(6);
    await expect(escrow.connect(publisher).acceptWork(taskId)).to.be.revertedWithCustomError(escrow, "InvalidState");
    expect(await token.balanceOf(agent.address)).to.be.greaterThan(ethers.parseEther("1030"));
  });

  it("uses three seats and forms an agent ruling after two valid votes", async () => {
    const { publisher, agent, m1, m2, token, committee, escrow } = await fixture();
    const taskId = ethers.id("task-dispute");
    const budget = ethers.parseEther("200");
    await token.connect(publisher).approve(await escrow.getAddress(), budget);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await escrow.connect(publisher).createTask(taskId, budget, now + 7 * 24 * 60 * 60);
    await escrow.connect(publisher).assignAgent(taskId, agent.address);
    await token.connect(agent).approve(await escrow.getAddress(), ethers.parseEther("12"));
    await escrow.connect(agent).acceptTask(taskId);
    await escrow.connect(publisher).openDispute(taskId);
    const caseData = await committee.getCase(taskId);
    expect(new Set(caseData.seats).size).to.equal(3);
    await committee.connect(m1).castVote(taskId, true);
    await committee.connect(m2).castVote(taskId, true);
    expect((await committee.getCase(taskId)).resolved).to.equal(true);
    expect((await escrow.tasks(taskId)).state).to.equal(6);
  });
});
