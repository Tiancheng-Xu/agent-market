import { expect } from "chai";
import { ethers } from "hardhat";
import type { YDToken } from "../typechain-types";

describe("YDToken", () => {
  it("mints one quota and rejects an immediate second claim", async () => {
    const [user] = await ethers.getSigners();
    const token = (await ethers.deployContract("YDToken")) as unknown as YDToken;
    await token.waitForDeployment();

    await token.connect(user).faucet();

    expect(await token.balanceOf(user.address)).to.equal(ethers.parseEther("1000"));
    await expect(token.connect(user).faucet()).to.be.revertedWithCustomError(
      token,
      "FaucetCoolingDown",
    );
  });

  it("allows a new claim after the cooldown", async () => {
    const [user] = await ethers.getSigners();
    const token = (await ethers.deployContract("YDToken")) as unknown as YDToken;
    await token.waitForDeployment();
    await token.connect(user).faucet();

    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await token.connect(user).faucet();

    expect(await token.balanceOf(user.address)).to.equal(ethers.parseEther("2000"));
  });

  it("grants each coursework airdrop once through the authorized distributor", async () => {
    const [owner, user, outsider] = await ethers.getSigners();
    const token = (await ethers.deployContract("YDToken")) as unknown as YDToken;
    await token.waitForDeployment();
    const agentRef = ethers.id("agent-demo");
    const taskRef = ethers.id("task-demo");

    await token.grantAgentAirdrop(user.address, agentRef);
    await token.grantPublisherAirdrop(user.address, taskRef);
    expect(await token.balanceOf(user.address)).to.equal(ethers.parseEther("1000"));
    await expect(token.grantAgentAirdrop(user.address, agentRef)).to.be.revertedWithCustomError(token, "AirdropAlreadyClaimed");
    await expect(token.connect(outsider).grantPublisherAirdrop(outsider.address, taskRef)).to.be.revertedWithCustomError(token, "NotAirdropDistributor");
    expect(await token.owner()).to.equal(owner.address);
  });
});
