import { ethers, network } from "hardhat";
import type { TransactionReceipt, TransactionResponse } from "ethers";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentMarketEscrow, ArbitrationCommittee, StakeYieldVault, YDToken } from "../typechain-types";
import { createDeploymentManifest, SEPOLIA_CHAIN_ID, writeDeploymentManifest, type ContractDeploymentRecord } from "../src/deployment-manifest";
import { createSepoliaClosureEvidence, deriveRoleAddresses, type ScenarioEvidence, type TransactionEvidence } from "../src/sepolia-closure";

const MANIFEST_PATH = "docs/evidence/deployment/sepolia-contracts.json";
const CLOSURE_PATH = "docs/evidence/deployment/2026-08-21-sepolia-v2-closure.json";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function send(action: string, transaction: Promise<TransactionResponse>): Promise<{ evidence: TransactionEvidence; receipt: TransactionReceipt }> {
  const response = await transaction;
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`SEPOLIA_TRANSACTION_FAILED:${action}`);
  return {
    evidence: { action, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, status: 1 },
    receipt,
  };
}

async function deploy<T>(name: string, args: readonly unknown[], signer: Awaited<ReturnType<typeof ethers.getSigners>>[number]): Promise<{ contract: T; record: ContractDeploymentRecord }> {
  const factory = await ethers.getContractFactory(name, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const receipt = await contract.deploymentTransaction()?.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`SEPOLIA_DEPLOYMENT_FAILED:${name}`);
  return {
    contract: contract as unknown as T,
    record: { address: await contract.getAddress(), transactionHash: receipt.hash, blockNumber: receipt.blockNumber },
  };
}

function settledEvent(escrow: AgentMarketEscrow, receipt: TransactionReceipt): { bond: bigint; yieldPaid: bigint } {
  for (const log of receipt.logs) {
    try {
      const parsed = escrow.interface.parseLog(log);
      if (parsed?.name === "TaskSettled") return { bond: parsed.args.bondPaidToPlatform, yieldPaid: parsed.args.yieldPaid };
    } catch {
      // Ignore logs emitted by YDToken or the arbitration committee.
    }
  }
  throw new Error("SEPOLIA_TASK_SETTLED_EVENT_MISSING");
}

async function assertRpcReceipts(transactions: readonly TransactionEvidence[]): Promise<void> {
  for (const transaction of transactions) {
    const receipt = await ethers.provider.getTransactionReceipt(transaction.transactionHash);
    if (!receipt || receipt.status !== 1 || receipt.blockNumber !== transaction.blockNumber) {
      throw new Error(`SEPOLIA_RPC_READBACK_FAILED:${transaction.action}`);
    }
  }
}

async function main(): Promise<void> {
  if (network.name !== "sepolia" || network.config.chainId !== SEPOLIA_CHAIN_ID) throw new Error("SEPOLIA_NETWORK_REQUIRED");
  const mnemonic = required("SEPOLIA_ROLE_MNEMONIC");
  const rpcUrl = required("SEPOLIA_RPC_URL");
  const derived = deriveRoleAddresses(mnemonic);
  const signers = await ethers.getSigners();
  if (signers.length < 9) throw new Error("SEPOLIA_ROLE_SIGNERS_REQUIRED");
  const [deployer, ...rest] = signers;
  if (!deployer || deployer.address !== derived.deployer) throw new Error("SEPOLIA_DEPLOYER_MISMATCH");
  const committeeSigners = rest.slice(0, 5);
  const publisher = signers[6];
  const agent = signers[7];
  const treasury = signers[8];
  if (!publisher || !agent || !treasury || committeeSigners.length !== 5) throw new Error("SEPOLIA_ROLE_SIGNERS_REQUIRED");

  const minimumBalance = ethers.parseEther(process.env.SEPOLIA_MIN_DEPLOYER_ETH?.trim() || "0.02");
  if (await ethers.provider.getBalance(deployer.address) < minimumBalance) {
    throw new Error(`SEPOLIA_FUNDING_REQUIRED address=${deployer.address} minimumEth=${ethers.formatEther(minimumBalance)}`);
  }

  const funding: TransactionEvidence[] = [];
  for (const [label, signer, target] of [
    ["publisher", publisher, "0.003"],
    ["agent", agent, "0.003"],
    ["committee-1", committeeSigners[0]!, "0.001"],
    ["committee-2", committeeSigners[1]!, "0.001"],
  ] as const) {
    const targetWei = ethers.parseEther(target);
    const balance = await ethers.provider.getBalance(signer.address);
    if (balance < targetWei) funding.push((await send(`fund-gas:${label}`, deployer.sendTransaction({ to: signer.address, value: targetWei - balance }))).evidence);
  }

  const tokenDeployment = await deploy<YDToken>("YDToken", [], deployer);
  const committeeDeployment = await deploy<ArbitrationCommittee>("ArbitrationCommittee", [committeeSigners.map((signer) => signer.address)], deployer);
  const escrowDeployment = await deploy<AgentMarketEscrow>("AgentMarketEscrow", [tokenDeployment.record.address, committeeDeployment.record.address, treasury.address], deployer);
  const vaultDeployment = await deploy<StakeYieldVault>("StakeYieldVault", [tokenDeployment.record.address], deployer);
  const token = tokenDeployment.contract;
  const committee = committeeDeployment.contract;
  const escrow = escrowDeployment.contract;
  const vault = vaultDeployment.contract;
  const authorization = await send("committee.authorize-escrow", committee.connect(deployer).setAuthorizedEscrow(escrowDeployment.record.address, true));

  const manifest = createDeploymentManifest({
    chainId: SEPOLIA_CHAIN_ID,
    deployer: deployer.address,
    platformTreasury: treasury.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      YDToken: tokenDeployment.record,
      ArbitrationCommittee: committeeDeployment.record,
      AgentMarketEscrow: escrowDeployment.record,
      StakeYieldVault: vaultDeployment.record,
    },
  });
  await writeDeploymentManifest(process.env.DEPLOYMENT_MANIFEST_PATH?.trim() || MANIFEST_PATH, manifest, [mnemonic, rpcUrl]);

  const setup: TransactionEvidence[] = [authorization.evidence];
  setup.push((await send("token.faucet:deployer", token.connect(deployer).faucet())).evidence);
  setup.push((await send("token.faucet:publisher", token.connect(publisher).faucet())).evidence);
  setup.push((await send("token.faucet:agent", token.connect(agent).faucet())).evidence);
  const reserve = ethers.parseEther("300");
  setup.push((await send("token.approve:reward-reserve", token.connect(deployer).approve(escrowDeployment.record.address, reserve))).evidence);
  setup.push((await send("escrow.fund-reward-reserve", escrow.connect(deployer).fundRewardPool(reserve))).evidence);

  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("SEPOLIA_LATEST_BLOCK_UNAVAILABLE");
  const deadline = latest.timestamp + 7 * 24 * 60 * 60;

  const normalTransactions: TransactionEvidence[] = [];
  const normalTaskId = ethers.id(`agent-market-v2-normal:${escrowDeployment.record.address}`);
  const normalRequestRef = ethers.id(`request:normal:${escrowDeployment.record.address}`);
  const normalBudget = ethers.parseEther("100");
  normalTransactions.push((await send("normal.approve-budget", token.connect(publisher).approve(escrowDeployment.record.address, normalBudget))).evidence);
  normalTransactions.push((await send("normal.create-task", escrow.connect(publisher).createTask(normalTaskId, normalRequestRef, normalBudget, deadline))).evidence);
  normalTransactions.push((await send("normal.assign-agent", escrow.connect(publisher).assignAgent(normalTaskId, agent.address))).evidence);
  const normalBond = normalBudget * 6n / 100n;
  normalTransactions.push((await send("normal.approve-bond", token.connect(agent).approve(escrowDeployment.record.address, normalBond))).evidence);
  normalTransactions.push((await send("normal.accept-task", escrow.connect(agent).acceptTask(normalTaskId))).evidence);
  normalTransactions.push((await send("normal.submit-work", escrow.connect(agent).submitWork(normalTaskId))).evidence);
  const normalSettlement = await send("normal.accept-work", escrow.connect(publisher).acceptWork(normalTaskId));
  normalTransactions.push(normalSettlement.evidence);
  const normalEvent = settledEvent(escrow, normalSettlement.receipt);
  if ((await escrow.tasks(normalTaskId)).state !== 6n || normalEvent.bond !== normalBond) throw new Error("SEPOLIA_NORMAL_SETTLEMENT_INVALID");

  const disputeTransactions: TransactionEvidence[] = [];
  const disputeTaskId = ethers.id(`agent-market-v2-dispute:${escrowDeployment.record.address}`);
  const disputeRequestRef = ethers.id(`request:dispute:${escrowDeployment.record.address}`);
  const disputeBudget = ethers.parseEther("80");
  disputeTransactions.push((await send("dispute.approve-budget", token.connect(publisher).approve(escrowDeployment.record.address, disputeBudget))).evidence);
  disputeTransactions.push((await send("dispute.create-task", escrow.connect(publisher).createTask(disputeTaskId, disputeRequestRef, disputeBudget, deadline))).evidence);
  disputeTransactions.push((await send("dispute.assign-agent", escrow.connect(publisher).assignAgent(disputeTaskId, agent.address))).evidence);
  const disputeBond = disputeBudget * 6n / 100n;
  disputeTransactions.push((await send("dispute.approve-bond", token.connect(agent).approve(escrowDeployment.record.address, disputeBond))).evidence);
  disputeTransactions.push((await send("dispute.accept-task", escrow.connect(agent).acceptTask(disputeTaskId))).evidence);
  disputeTransactions.push((await send("dispute.submit-work", escrow.connect(agent).submitWork(disputeTaskId))).evidence);
  disputeTransactions.push((await send("dispute.open", escrow.connect(publisher).openDispute(disputeTaskId))).evidence);
  const caseData = await committee.getCase(disputeTaskId);
  const voterByAddress = new Map(committeeSigners.map((signer) => [signer.address.toLowerCase(), signer]));
  const voterOne = voterByAddress.get(caseData.seats[0].toLowerCase());
  const voterTwo = voterByAddress.get(caseData.seats[1].toLowerCase());
  if (!voterOne || !voterTwo) throw new Error("SEPOLIA_COMMITTEE_SIGNER_MISSING");
  disputeTransactions.push((await send("dispute.vote-1:publisher", committee.connect(voterOne).castVote(disputeTaskId, false))).evidence);
  const disputeSettlement = await send("dispute.vote-2:publisher", committee.connect(voterTwo).castVote(disputeTaskId, false));
  disputeTransactions.push(disputeSettlement.evidence);
  const disputeEvent = settledEvent(escrow, disputeSettlement.receipt);
  if ((await escrow.tasks(disputeTaskId)).state !== 7n || disputeEvent.bond !== disputeBond) throw new Error("SEPOLIA_DISPUTE_SETTLEMENT_INVALID");

  const stakingTransactions: TransactionEvidence[] = [];
  const principal = ethers.parseEther("50");
  stakingTransactions.push((await send("staking.approve", token.connect(agent).approve(vaultDeployment.record.address, principal))).evidence);
  stakingTransactions.push((await send("staking.stake", vault.connect(agent).stake(principal))).evidence);
  stakingTransactions.push((await send("staking.unstake", vault.connect(agent).unstake(principal))).evidence);
  const finalPrincipal = (await vault.positions(agent.address)).principal;
  if (finalPrincipal !== 0n) throw new Error("SEPOLIA_STAKING_ROUNDTRIP_INVALID");

  const allTransactions = [...funding, ...setup, ...normalTransactions, ...disputeTransactions, ...stakingTransactions];
  await assertRpcReceipts(allTransactions);
  const scenario = (taskId: string, requestRef: string, finalState: ScenarioEvidence["finalState"], agentWins: boolean, budget: bigint, event: { bond: bigint; yieldPaid: bigint }, transactions: TransactionEvidence[]): ScenarioEvidence => ({
    taskId,
    requestRef,
    finalState,
    agentWins,
    budgetAtomic: budget.toString(),
    bondPaidToPlatformAtomic: event.bond.toString(),
    yieldPaidAtomic: event.yieldPaid.toString(),
    transactions,
  });
  const evidence = createSepoliaClosureEvidence({
    capturedAt: new Date().toISOString(),
    deployment: manifest,
    roles: derived,
    normalSettlement: scenario(normalTaskId, normalRequestRef, "SETTLED", true, normalBudget, normalEvent, normalTransactions),
    disputeSettlement: scenario(disputeTaskId, disputeRequestRef, "REFUNDED", false, disputeBudget, disputeEvent, disputeTransactions),
    staking: { principalAtomic: principal.toString(), finalPrincipalAtomic: finalPrincipal.toString(), transactions: stakingTransactions },
    rpcReadback: { checkedTransactions: allTransactions.length, allReceiptsSuccessful: true },
  }, [mnemonic, rpcUrl]);
  const outputPath = process.env.SEPOLIA_CLOSURE_EVIDENCE_PATH?.trim() || CLOSURE_PATH;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`SEPOLIA_CLOSURE_RPC_VERIFIED evidence=${outputPath} settlementTx=${normalSettlement.evidence.transactionHash} disputeTx=${disputeSettlement.evidence.transactionHash}\n`);
}

main().catch((error: unknown) => {
  const safe = error instanceof Error && error.message.startsWith("SEPOLIA_FUNDING_REQUIRED") ? error.message : "SEPOLIA_CLOSURE_FAILED";
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
});
