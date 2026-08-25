import { expect } from "chai";
import { ethers } from "hardhat";
import type { AgentMarketWorkflowEscrow, TaskStakeReceipt, YDToken } from "../typechain-types";

describe("Agent Market V3 workflow escrow", () => {
  async function fixture() {
    const [deployer, publisher, platformArbiter, agentA, agentB, agentC, outsider] = await ethers.getSigners();
    const token = (await ethers.deployContract("YDToken")) as unknown as YDToken;
    const receipt = (await ethers.deployContract("TaskStakeReceipt")) as unknown as TaskStakeReceipt;
    const escrow = (await ethers.deployContract("AgentMarketWorkflowEscrow", [
      await token.getAddress(),
      await receipt.getAddress(),
      deployer.address,
      platformArbiter.address,
    ])) as unknown as AgentMarketWorkflowEscrow;
    await Promise.all([token.waitForDeployment(), receipt.waitForDeployment(), escrow.waitForDeployment()]);
    await receipt.configureEscrow(await escrow.getAddress());
    for (const signer of [publisher, agentA, agentB, agentC]) await token.connect(signer).faucet();
    return { deployer, publisher, platformArbiter, agentA, agentB, agentC, outsider, token, receipt, escrow };
  }

  async function createAndAssign() {
    const context = await fixture();
    const { deployer, publisher, platformArbiter, agentA, agentB, agentC, token, escrow } = context;
    const taskId = ethers.id("workflow-task");
    const requestRef = ethers.id("workflow-request");
    const budget = ethers.parseEther("100");
    const fee = ethers.parseEther("6");
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 7 * 24 * 60 * 60;
    await token.connect(publisher).approve(await escrow.getAddress(), budget + fee);
    const treasuryBefore = await token.balanceOf(deployer.address);
    await expect(escrow.connect(publisher).createTask(taskId, requestRef, budget, deadline))
      .to.emit(escrow, "TaskCreated")
      .withArgs(taskId, requestRef, publisher.address, budget, fee, deadline);
    expect((await token.balanceOf(deployer.address)) - treasuryBefore).to.equal(fee);

    const workflowId = ethers.id("workflow-v1");
    const dagHash = ethers.id("dag-v1");
    await expect(escrow.connect(platformArbiter).anchorWorkflow(taskId, workflowId, dagHash, 1))
      .to.emit(escrow, "WorkflowAnchored")
      .withArgs(taskId, workflowId, dagHash, 1);

    const assignments = [
      { signer: agentA, nodeId: ethers.id("execute"), shareBps: 3333 },
      { signer: agentB, nodeId: ethers.id("judge"), shareBps: 3333 },
      { signer: agentC, nodeId: ethers.id("arbitrate"), shareBps: 3334 },
    ];
    const stake = ethers.parseEther("3");
    for (const assignment of assignments) {
      await escrow.connect(publisher).assignNode(taskId, assignment.nodeId, assignment.signer.address, stake, assignment.shareBps);
    }
    for (const assignment of assignments) {
      await token.connect(assignment.signer).approve(await escrow.getAddress(), stake);
      await escrow.connect(assignment.signer).acceptNode(taskId, assignment.nodeId);
    }
    return { ...context, taskId, budget, fee, stake, assignments };
  }

  it("takes a fixed non-refundable six percent publication fee and anchors workflow identity", async () => {
    const { escrow, taskId, budget, fee } = await createAndAssign();
    const task = await escrow.tasks(taskId);
    expect(await escrow.PUBLICATION_FEE_PERCENT()).to.equal(6);
    expect(task.budget).to.equal(budget);
    expect(task.publicationFee).to.equal(fee);
    expect(task.workflowVersion).to.equal(1);
    expect(task.acceptedShareBps).to.equal(10_000);
  });

  it("uses the receipt as the unique proof for returning each successful Agent stake", async () => {
    const { platformArbiter, agentA, token, receipt, escrow, taskId, stake, assignments } = await createAndAssign();
    const nodeId = assignments[0]!.nodeId;
    const assignment = await escrow.assignments(taskId, nodeId);
    expect(await receipt.ownerOf(assignment.receiptId)).to.equal(agentA.address);
    await escrow.connect(platformArbiter).resolveTask(taskId, true);
    const before = await token.balanceOf(agentA.address);
    await expect(escrow.connect(agentA).claimStake(assignment.receiptId))
      .to.emit(escrow, "StakeClaimed")
      .withArgs(taskId, nodeId, agentA.address, assignment.receiptId, stake);
    expect((await token.balanceOf(agentA.address)) - before).to.equal(stake);
    await expect(receipt.ownerOf(assignment.receiptId)).to.be.reverted;
  });

  it("allows only the configured platform arbiter to issue the final ruling", async () => {
    const { outsider, platformArbiter, escrow, taskId } = await createAndAssign();
    await expect(escrow.connect(outsider).resolveTask(taskId, true))
      .to.be.revertedWithCustomError(escrow, "Unauthorized")
      .withArgs(outsider.address);
    await expect(escrow.connect(platformArbiter).resolveTask(taskId, true))
      .to.emit(escrow, "TaskResolved")
      .withArgs(taskId, true, platformArbiter.address, ethers.parseEther("100"));
  });

  it("returns the budget to the publisher and forfeits Agent stakes after a publisher-winning ruling", async () => {
    const { deployer, publisher, platformArbiter, agentA, token, receipt, escrow, taskId, stake, assignments, budget } = await createAndAssign();
    const assignment = await escrow.assignments(taskId, assignments[0]!.nodeId);
    const publisherBefore = await token.balanceOf(publisher.address);
    const treasuryBefore = await token.balanceOf(deployer.address);
    await escrow.connect(platformArbiter).resolveTask(taskId, false);
    expect((await token.balanceOf(publisher.address)) - publisherBefore).to.equal(budget);
    expect((await token.balanceOf(deployer.address)) - treasuryBefore).to.equal(stake * 3n);
    await expect(receipt.ownerOf(assignment.receiptId)).to.be.reverted;
    await expect(escrow.connect(agentA).claimStake(assignment.receiptId)).to.be.revertedWithCustomError(escrow, "StakeNotClaimable");
  });
});
