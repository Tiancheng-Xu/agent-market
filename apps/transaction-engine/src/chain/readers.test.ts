import { describe, expect, it } from "vitest";

import { BlockscoutMcpChainReader } from "./readers";

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
