import { describe, expect, it } from "vitest";
import { BlockscoutMcpChainReader } from "./readers";

const txHash = `0x${"12".repeat(32)}`;
const blockHash = `0x${"34".repeat(32)}`;

function observationResponse(tool: string): Response {
  switch (tool) {
    case "get_transaction_info": return Response.json({ data: {
      hash: txHash, block_number: 100, block_hash: blockHash, status: "ok",
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222", raw_input: "0x1234", value: "0",
    } });
    case "direct_api_call": return Response.json({ data: { items: [] } });
    case "get_block_number": return Response.json({ data: { block_number: 101 } });
    case "get_block_info": return Response.json({ data: { hash: blockHash } });
    default: throw new Error(`Unexpected test request: ${tool}`);
  }
}

const failures = [
  { name: "HTTP 503", fail: async () => new Response(null, { status: 503 }) },
  { name: "network rejection", fail: async (): Promise<Response> => { throw new TypeError("fetch failed"); } },
  { name: "timeout", fail: async (): Promise<Response> => { throw new DOMException("expired", "TimeoutError"); } },
];

describe("Blockscout unlock recovery", () => {
  for (const failure of failures) {
    it(`bounds ${failure.name} retries and recovers on the same instance after concurrent failure`, async () => {
      let unavailable = true;
      let unlockCalls = 0;
      let transactionCalls = 0;
      const reader = new BlockscoutMcpChainReader(async (input) => {
        const tool = new URL(String(input)).pathname.split("/").at(-1)!;
        if (tool === "unlock_blockchain_analysis") {
          unlockCalls += 1;
          return unavailable ? failure.fail() : Response.json({ ok: true });
        }
        if (tool === "get_transaction_info") transactionCalls += 1;
        return observationResponse(tool);
      });
      const first = await Promise.allSettled(Array.from({ length: 5 }, () => reader.readTransaction(txHash)));
      for (const result of first) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason.message).toBe("BLOCKSCOUT_UNAVAILABLE");
      }
      expect(unlockCalls).toBe(3);
      expect(transactionCalls).toBe(0);
      unavailable = false;
      const recovered = await Promise.all(Array.from({ length: 5 }, () => reader.readTransaction(txHash)));
      for (const observation of recovered) {
        expect(observation?.transaction?.hash).toBe(txHash);
        expect(observation?.receipt?.status).toBe("success");
        expect(observation?.canonicalBlockHash).toBe(blockHash);
      }
      expect(unlockCalls).toBe(4);
      await reader.readTransaction(txHash);
      expect(unlockCalls).toBe(4);
    });

    it(`recovers from a first ${failure.name} within the bounded attempt`, async () => {
      let unlockCalls = 0;
      const reader = new BlockscoutMcpChainReader(async (input) => {
        const tool = new URL(String(input)).pathname.split("/").at(-1)!;
        if (tool === "unlock_blockchain_analysis") {
          unlockCalls += 1;
          return unlockCalls === 1 ? failure.fail() : Response.json({ ok: true });
        }
        return observationResponse(tool);
      });
      expect((await reader.readTransaction(txHash))?.transaction?.hash).toBe(txHash);
      expect(unlockCalls).toBe(2);
    });
  }

  it.each([400, 401, 403, 404, 429])("does not retry HTTP %s but permits a later unlock", async (status) => {
    let unlockCalls = 0;
    const reader = new BlockscoutMcpChainReader(async (input) => {
      const tool = new URL(String(input)).pathname.split("/").at(-1)!;
      if (tool === "unlock_blockchain_analysis") {
        unlockCalls += 1;
        return unlockCalls === 1 ? new Response(null, { status }) : Response.json({ ok: true });
      }
      return observationResponse(tool);
    });
    await expect(reader.readTransaction(txHash)).rejects.toThrow("BLOCKSCOUT_UNAVAILABLE");
    expect(unlockCalls).toBe(1);
    expect((await reader.readTransaction(txHash))?.transaction?.hash).toBe(txHash);
    expect(unlockCalls).toBe(2);
  });

  it("clears a rejected response-body parse without caching it forever", async () => {
    let unlockCalls = 0;
    const reader = new BlockscoutMcpChainReader(async (input) => {
      const tool = new URL(String(input)).pathname.split("/").at(-1)!;
      if (tool === "unlock_blockchain_analysis") {
        unlockCalls += 1;
        return unlockCalls === 1 ? new Response("invalid-json") : Response.json({ ok: true });
      }
      return observationResponse(tool);
    });
    await expect(reader.readTransaction(txHash)).rejects.toThrow();
    expect((await reader.readTransaction(txHash))?.transaction?.hash).toBe(txHash);
    expect(unlockCalls).toBe(2);
  });

  it("keeps a successful unlock cached when downstream transaction reads fail", async () => {
    let unlockCalls = 0;
    let unavailable = true;
    let transactionCalls = 0;
    const reader = new BlockscoutMcpChainReader(async (input) => {
      const tool = new URL(String(input)).pathname.split("/").at(-1)!;
      if (tool === "unlock_blockchain_analysis") {
        unlockCalls += 1;
        return Response.json({ ok: true });
      }
      if (tool === "get_transaction_info") {
        transactionCalls += 1;
        if (unavailable) return new Response(null, { status: 503 });
      }
      return observationResponse(tool);
    });
    await expect(reader.readTransaction(txHash)).rejects.toThrow("BLOCKSCOUT_UNAVAILABLE");
    expect(transactionCalls).toBe(3);
    unavailable = false;
    expect((await reader.readTransaction(txHash))?.transaction?.hash).toBe(txHash);
    expect(unlockCalls).toBe(1);
  });
});
