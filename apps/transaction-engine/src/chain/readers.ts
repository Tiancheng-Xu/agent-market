import type { ChainObservation, ChainReader } from "./reconcile";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RpcEnvelope {
  result?: unknown;
  error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unwrap(value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  return asRecord(root.data ?? root.result ?? root.structuredContent ?? root);
}

function hexNumber(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decimalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function address(value: unknown): string | null {
  if (typeof value === "string") return value.toLowerCase();
  const nested = asRecord(value);
  return typeof nested.hash === "string" ? nested.hash.toLowerCase() : null;
}

export class JsonRpcChainReader implements ChainReader {
  private requestId = 0;

  constructor(
    private readonly rpcUrl: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 8_000,
  ) {}

  private async call(method: string, params: readonly unknown[]): Promise<unknown> {
    const response = await this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error("RPC_UNAVAILABLE");
    const payload = await response.json() as RpcEnvelope;
    if (payload.error) throw new Error("RPC_ERROR");
    return payload.result;
  }

  async readTransaction(txHash: string): Promise<ChainObservation | null> {
    const [txValue, receiptValue, latestValue, chainValue] = await Promise.all([
      this.call("eth_getTransactionByHash", [txHash]),
      this.call("eth_getTransactionReceipt", [txHash]),
      this.call("eth_blockNumber", []),
      this.call("eth_chainId", []),
    ]);
    if (txValue === null || receiptValue === null) return null;
    const tx = asRecord(txValue);
    const receipt = asRecord(receiptValue);
    const blockNumber = hexNumber(receipt.blockNumber);
    const latestBlockNumber = hexNumber(latestValue);
    const chainId = hexNumber(chainValue);
    if (blockNumber === null || latestBlockNumber === null || chainId === null
      || typeof receipt.blockHash !== "string" || typeof tx.hash !== "string"
      || typeof tx.from !== "string" || typeof tx.input !== "string" || typeof tx.value !== "string") return null;
    const canonical = asRecord(await this.call("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]));
    const logs = Array.isArray(receipt.logs) ? receipt.logs.map((value) => {
      const log = asRecord(value);
      return {
        address: String(log.address ?? "").toLowerCase(),
        topics: Array.isArray(log.topics) ? log.topics.map(String).map((topic) => topic.toLowerCase()) : [],
        data: String(log.data ?? "0x").toLowerCase(),
      };
    }) : [];
    return {
      transaction: {
        hash: tx.hash.toLowerCase(),
        chainId,
        from: tx.from.toLowerCase(),
        to: typeof tx.to === "string" ? tx.to.toLowerCase() : null,
        data: tx.input.toLowerCase(),
        valueAtomic: BigInt(tx.value).toString(),
        blockNumber,
        blockHash: String(tx.blockHash ?? receipt.blockHash).toLowerCase(),
      },
      receipt: {
        status: receipt.status === "0x1" ? "success" : "failed",
        blockNumber,
        blockHash: receipt.blockHash.toLowerCase(),
        logs,
      },
      latestBlockNumber,
      canonicalBlockHash: typeof canonical.hash === "string" ? canonical.hash.toLowerCase() : null,
    };
  }
}

export class BlockscoutMcpChainReader implements ChainReader {
  private unlockPromise?: Promise<void>;

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 8_000,
    private readonly chainId = 11_155_111,
  ) {}

  private async call(tool: string, params: Record<string, string | number> = {}): Promise<unknown> {
    const url = new URL(`https://mcp.blockscout.com/v1/${tool}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await this.fetcher(url, {
        headers: { "user-agent": "Blockscout-SkillGuidedScript/0.6.0", accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.ok) return response.json();
      if (response.status < 500 || attempt === 3) throw new Error("BLOCKSCOUT_UNAVAILABLE");
    }
    throw new Error("BLOCKSCOUT_UNAVAILABLE");
  }

  private async unlock(): Promise<void> {
    this.unlockPromise ??= this.call("unlock_blockchain_analysis").then(() => undefined);
    return this.unlockPromise;
  }

  async readTransaction(txHash: string): Promise<ChainObservation | null> {
    await this.unlock();
    const transactionPayload = await this.call("get_transaction_info", {
      chain_id: this.chainId,
      hash: txHash,
      include_raw_input: "true",
    });
    const tx = unwrap(transactionPayload);
    const blockNumber = decimalNumber(tx.block_number);
    if (blockNumber === null || typeof tx.hash !== "string") return null;
    const [logsPayload, latestPayload, blockPayload] = await Promise.all([
      this.call("direct_api_call", {
        chain_id: this.chainId,
        endpoint_path: `/api/v2/transactions/${txHash}/logs`,
      }),
      this.call("get_block_number", { chain_id: this.chainId }),
      this.call("get_block_info", { chain_id: this.chainId, number_or_hash: blockNumber }),
    ]);
    const logsRoot = unwrap(logsPayload);
    const logsItems = Array.isArray(logsRoot.items) ? logsRoot.items : [];
    const logs = logsItems.map((value) => {
      const log = asRecord(value);
      return {
        address: address(log.address) ?? "",
        topics: Array.isArray(log.topics) ? log.topics.map(String).map((topic) => topic.toLowerCase()) : [],
        data: String(log.data ?? "0x").toLowerCase(),
      };
    });
    const latest = unwrap(latestPayload);
    const block = unwrap(blockPayload);
    const transactionBlockHash = typeof tx.block_hash === "string" ? tx.block_hash.toLowerCase() : null;
    const canonicalBlockHash = typeof block.hash === "string" ? block.hash.toLowerCase() : null;
    const from = address(tx.from);
    const to = address(tx.to);
    const rawInput = typeof tx.raw_input === "string" ? tx.raw_input.toLowerCase() : null;
    const latestBlockNumber = decimalNumber(latest.block_number ?? latest.number);
    if (!transactionBlockHash || !canonicalBlockHash || !from || !rawInput || latestBlockNumber === null) return null;
    return {
      transaction: {
        hash: tx.hash.toLowerCase(),
        chainId: this.chainId,
        from,
        to,
        data: rawInput,
        valueAtomic: typeof tx.value === "string" ? tx.value : "0",
        blockNumber,
        blockHash: transactionBlockHash,
      },
      receipt: {
        status: tx.status === "ok" || tx.status === "success" ? "success" : "failed",
        blockNumber,
        blockHash: transactionBlockHash,
        logs,
      },
      latestBlockNumber,
      canonicalBlockHash,
    };
  }
}
