import { Interface, Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import { BlockscoutMcpChainReader, JsonRpcVaultPositionReader } from "./readers";

describe("Blockscout MCP reader", () => {
  it("uses get_block_info as the independent canonical hash and unlocks first", async () => {
    const txHash = `0x${"12".repeat(32)}`;
    const transactionBlockHash = `0x${"34".repeat(32)}`;
    const canonicalBlockHash = `0x${"56".repeat(32)}`;
    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("/unlock_blockchain_analysis")) return Response.json({ ok: true });
      if (url.pathname.endsWith("/get_transaction_info")) {
        expect(url.searchParams.get("transaction_hash")).toBe(txHash);
        return Response.json({ data: {
        hash: txHash,
        block_number: 100,
        block_hash: transactionBlockHash,
        status: "ok",
        from: { hash: "0x1111111111111111111111111111111111111111" },
        to: { hash: "0x2222222222222222222222222222222222222222" },
        raw_input: "0x1234",
        value: "0",
        } });
      }
      if (url.pathname.endsWith("/direct_api_call")) return Response.json({ data: { items: [] } });
      if (url.pathname.endsWith("/get_block_number")) return Response.json({ data: { block_number: 101 } });
      if (url.pathname.endsWith("/get_block_info")) return Response.json({ data: { hash: canonicalBlockHash } });
      return new Response(null, { status: 404 });
    };
    const observation = await new BlockscoutMcpChainReader(fetcher).readTransaction(txHash);
    expect(calls[0]).toMatch(/unlock_blockchain_analysis$/u);
    expect(observation?.transaction?.blockHash).toBe(transactionBlockHash);
    expect(observation?.canonicalBlockHash).toBe(canonicalBlockHash);
  });
});

describe("Sepolia vault position reader", () => {
  it("reads principal, accrued, earned, reserve and block without sending a transaction", async () => {
    const contractInterface = new Interface([
      "function positions(address account) view returns (uint256 principal,uint256 accrued,uint64 checkpointAt)",
      "function earned(address account) view returns (uint256)",
      "function rewardReserve() view returns (uint256)",
    ]);
    const wallet = Wallet.createRandom().address;
    const vault = Wallet.createRandom().address;
    const methods: string[] = [];
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: Array<{ data?: string }> };
      methods.push(body.method);
      if (body.method === "eth_blockNumber") return Response.json({ result: "0x64" });
      const data = body.params[0]?.data ?? "";
      if (data.startsWith(contractInterface.getFunction("positions")!.selector)) {
        return Response.json({ result: contractInterface.encodeFunctionResult("positions", [100n, 6n, 1_800_000_000]) });
      }
      if (data.startsWith(contractInterface.getFunction("earned")!.selector)) {
        return Response.json({ result: contractInterface.encodeFunctionResult("earned", [9n]) });
      }
      return Response.json({ result: contractInterface.encodeFunctionResult("rewardReserve", [1_000n]) });
    };
    await expect(new JsonRpcVaultPositionReader(
      "https://rpc.example", vault, fetcher, 8_000, () => new Date("2026-08-26T13:40:00.000Z"),
    ).readPosition(wallet)).resolves.toEqual({
      wallet: wallet.toLowerCase(), principalAtomic: "100", accruedAtomic: "6",
      checkpointAt: "1800000000", earnedAtomic: "9", rewardReserveAtomic: "1000",
      blockNumber: 100, checkedAt: "2026-08-26T13:40:00.000Z",
    });
    expect(methods).toEqual(["eth_call", "eth_call", "eth_call", "eth_blockNumber"]);
  });
});
