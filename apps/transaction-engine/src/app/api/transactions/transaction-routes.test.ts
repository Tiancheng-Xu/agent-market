import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import { MemoryAuthStore } from "../../../auth/auth-store";
import { formatChallengeMessage } from "../../../auth/challenge";
import { WalletAuthService } from "../../../auth/session";
import { getTransactionMethodDefinition } from "../../../chain/intents";
import { deriveChainResource } from "../../../chain/policy";
import { MemoryChainResourceRepository } from "../../../chain/resources";
import type { ChainObservation, ChainReader } from "../../../chain/reconcile";
import { MemoryTransactionStore } from "../../../chain/transaction-store";
import { createIntentHandler } from "./intents/route";
import { createTransactionVerifyHandler } from "./verify/route";
import { createTaskDraftHandler } from "../tasks/route";

const now = new Date("2026-08-21T12:00:00.000Z");
const requestId = "0191f6f8-cb6b-7f31-81ad-c497d7d90301";
const resourceId = "0191f6f8-cb6b-7f31-81ad-c497d7d90304";
const { requestRef, taskId } = deriveChainResource(resourceId);
const contract = "0x2222222222222222222222222222222222222222";
const contracts = { token: contract, escrow: contract, committee: contract, vault: contract, workflowEscrow: contract };
const txHash = `0x${"56".repeat(32)}`;
const blockHash = `0x${"78".repeat(32)}`;

function resourcesFor(wallet: string) {
  return new MemoryChainResourceRepository([{
    resourceId,
    publisherWallet: wallet,
    agentWallet: null,
    budgetAtomic: "6000000",
    status: "open",
  }]);
}

async function authenticatedWallet() {
  const wallet = Wallet.createRandom();
  let id = 0;
  const ids = [
    "0191f6f8-cb6b-7f31-81ad-c497d7d90302",
    "0191f6f8-cb6b-7f31-81ad-c497d7d90303",
  ];
  const auth = new WalletAuthService(new MemoryAuthStore(), {
    now: () => now,
    id: () => ids[id++]!,
    nonce: () => "0123456789abcdef01234567",
    sessionToken: () => "transaction-route-session",
  });
  const challenge = await auth.issueChallenge(wallet.address, {
    requestId,
    domain: "agent-market.test",
    uri: "https://agent-market.test",
  });
  const message = formatChallengeMessage(challenge);
  await auth.verifyChallenge(message, await wallet.signMessage(message));
  return { auth, wallet, cookie: "__Host-agent_market_session=transaction-route-session" };
}

function reader(intent: { data: string; from: string }): ChainReader {
  const definition = getTransactionMethodDefinition("createTask");
  const event = definition.contractInterface.encodeEventLog(
    definition.contractInterface.getEvent("TaskCreated")!,
    [taskId, requestRef, intent.from, "6000000", 1_800_000_000],
  );
  const observation: ChainObservation = {
    transaction: {
      hash: txHash,
      chainId: 11_155_111,
      from: intent.from,
      to: contract,
      data: intent.data,
      valueAtomic: "0",
      blockNumber: 100,
      blockHash,
    },
    receipt: {
      status: "success",
      blockNumber: 100,
      blockHash,
      logs: [{ address: contract, topics: event.topics, data: event.data }],
    },
    latestBlockNumber: 101,
    canonicalBlockHash: blockHash,
  };
  return { async readTransaction() { return observation; } };
}

describe("transaction intent and verification routes", () => {
  it("creates a wallet-owned funding-pending task resource without accepting actor overrides", async () => {
    const { auth, wallet, cookie } = await authenticatedWallet();
    const resources = new MemoryChainResourceRepository([]);
    const response = await createTaskDraftHandler({
      auth,
      resources,
      authOrigin: new URL("https://agent-market.test"),
      id: () => resourceId,
    })(new Request("https://agent-market.test/api/tasks", {
      method: "POST",
      headers: { cookie, origin: "https://agent-market.test", "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({
        title: "Verified task",
        description: "Deliver a source-backed result.",
        category: "Research",
        tags: ["Research", "citations"],
        budgetAtomic: "100000000000000000000",
      }),
    }));
    const body = await response.json() as { task: { resourceId: string; platformFeeAtomic: string; platformFeeStatus: string } };
    expect(response.status).toBe(201);
    expect(body.task).toEqual(expect.objectContaining({
      resourceId,
      platformFeeAtomic: "6000000000000000000",
      platformFeeStatus: "included-in-v3-workflow-escrow-allowance",
    }));
    await expect(resources.requireAuthorized(resourceId, wallet.address, "createTask")).resolves.toMatchObject({
      publisherWallet: wallet.address.toLowerCase(),
      status: "funding_pending",
    });
  });

  it("derives the sender from the signed session and rejects signing-material overrides", async () => {
    const { auth, wallet, cookie } = await authenticatedWallet();
    const store = new MemoryTransactionStore();
    const handler = createIntentHandler({
      auth, store, resources: resourcesFor(wallet.address), contracts, now: () => now,
    });
    const forbidden = await handler(new Request("https://agent-market.test/api/transactions/intents", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ resourceId, method: "createTask", args: {}, to: contract }),
    }));
    expect(forbidden.status).toBe(400);

    const response = await handler(new Request("https://agent-market.test/api/transactions/intents", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({
        resourceId,
        method: "createTask",
        args: { taskId, budgetAtomic: "6000000", deadline: 1_800_000_000 },
      }),
    }));
    const body = await response.json() as { intent: { from: string; data: string; intentId: string } };
    expect(response.status).toBe(201);
    expect(body.intent.from).toBe(wallet.address.toLowerCase());
    expect(JSON.stringify(body)).not.toMatch(/privateKey|signature/u);
  });

  it("confirms a session-owned intent and returns only the public evidence projection", async () => {
    const { auth, wallet, cookie } = await authenticatedWallet();
    const store = new MemoryTransactionStore();
    const createResponse = await createIntentHandler({
      auth, store, resources: resourcesFor(wallet.address), contracts, now: () => now,
    })(new Request(
      "https://agent-market.test/api/transactions/intents",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({
          resourceId,
          method: "createTask",
          args: { taskId, budgetAtomic: "6000000", deadline: 1_800_000_000 },
        }),
      },
    ));
    const created = await createResponse.json() as { intent: { intentId: string; from: string; data: string } };
    const chainReader = reader(created.intent);
    const response = await createTransactionVerifyHandler({
      auth, store, rpc: chainReader, blockscout: chainReader,
      now: () => new Date("2026-08-21T12:06:00.000Z"),
    })(new Request("https://agent-market.test/api/transactions/verify", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ intentId: created.intent.intentId, txHash }),
    }));
    const body = await response.json() as { verification: { status: string }; evidence: Record<string, unknown> };
    expect(response.status).toBe(200);
    expect(body.verification.status).toBe("confirmed");
    expect(body.evidence).toMatchObject({
      txHash,
      eventName: "TaskCreated",
      requestRef,
      blockNumber: 100,
      confirmations: 2,
      status: "confirmed",
    });
    expect(body.evidence).not.toHaveProperty("data");
    expect(body.evidence).not.toHaveProperty("errorCode");
  });

  it("returns the same persisted intent for a retry and maps method/ABI errors to 400", async () => {
    const { auth, wallet, cookie } = await authenticatedWallet();
    const store = new MemoryTransactionStore();
    let tick = 0;
    const handler = createIntentHandler({
      auth,
      store,
      resources: resourcesFor(wallet.address),
      contracts,
      now: () => new Date(now.getTime() + tick++ * 1_000),
    });
    const request = (method: string, args: Record<string, unknown>) => new Request(
      "https://agent-market.test/api/transactions/intents",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ resourceId, method, args }),
      },
    );
    const first = await handler(request("createTask", { deadline: 1_800_000_000 }));
    const second = await handler(request("createTask", { deadline: 1_800_000_000 }));
    expect((await second.json() as { intent: unknown }).intent)
      .toEqual((await first.json() as { intent: unknown }).intent);
    expect((await handler(request("unknownMethod", {}))).status).toBe(400);
    expect((await handler(request("createTask", { deadline: "not-a-uint" }))).status).toBe(400);
  });

  it("rejects direct V3 resolution intents without a current matching review and binds the review identity", async () => {
    const { auth, wallet, cookie } = await authenticatedWallet();
    const store = new MemoryTransactionStore();
    const resources = new MemoryChainResourceRepository([{
      resourceId, publisherWallet: Wallet.createRandom().address, agentWallet: null,
      budgetAtomic: "6000000", status: "disputed", revision: 4,
    }], [], wallet.address);
    const handler = createIntentHandler({ auth, store, resources, contracts, now: () => now });
    const request = (agentsWin: boolean) => new Request("https://agent-market.test/api/transactions/intents", {
      method: "POST",
      headers: { cookie, origin: "https://agent-market.test", "content-type": "application/json" },
      body: JSON.stringify({ resourceId, method: "resolveWorkflowTask", args: { agentsWin } }),
    });

    const bypass = await handler(request(true));
    expect(bypass.status).toBe(409);
    expect(await bypass.json()).toEqual(expect.objectContaining({ error: "CHAIN_ARBITRATION_REVIEW_REQUIRED" }));

    const review = await resources.recordArbitrationReview(resourceId, wallet.address, { agentsWin: true }, now);
    const switched = await handler(request(false));
    expect(switched.status).toBe(409);
    expect(await switched.json()).toEqual(expect.objectContaining({ error: "CHAIN_ARBITRATION_REVIEW_ARGS_MISMATCH" }));

    const response = await handler(request(true));
    const body = await response.json() as { intent: { intentId: string } };
    expect(response.status).toBe(201);
    await expect(store.findExpectation(body.intent.intentId)).resolves.toMatchObject({
      resourceId, resourceRevision: 4, reviewId: review.reviewId,
      reviewHash: review.reviewHash, reviewExpiresAt: review.expiresAt, agentWins: true,
    });
  });
});
