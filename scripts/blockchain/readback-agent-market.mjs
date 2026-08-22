#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const MCP_BASE = "https://mcp.blockscout.com/v1";
const USER_AGENT = "Blockscout-SkillGuidedScript/0.6.0";
const TX_HASH = /^0x[0-9a-fA-F]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const TOPIC = /^0x[0-9a-fA-F]{64}$/u;

function usage() {
  console.error("Usage: node scripts/blockchain/readback-agent-market.mjs <tx-hash> <chain-id> <contract-address> <event-topic>");
  process.exitCode = 2;
}

async function call(tool, params = {}) {
  const url = new URL(`${MCP_BASE}/${tool}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) return response.json();
    if (response.status < 500 || attempt === 3) {
      throw new Error(`BLOCKSCOUT_${tool.toUpperCase()}_${response.status}`);
    }
  }
  throw new Error(`BLOCKSCOUT_${tool.toUpperCase()}_UNAVAILABLE`);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function unwrap(payload) {
  const root = object(payload);
  return object(root.data ?? root.result ?? root.structuredContent ?? root);
}

function address(value) {
  if (typeof value === "string") return value.toLowerCase();
  const nested = object(value);
  return typeof nested.hash === "string" ? nested.hash.toLowerCase() : null;
}

export function compactTransaction(payload, txHash) {
  const tx = unwrap(payload);
  const rawInput = typeof tx.raw_input === "string" ? tx.raw_input.toLowerCase() : null;
  const observedHash = typeof tx.hash === "string" ? tx.hash.toLowerCase() : null;
  const blockNumber = Number.isSafeInteger(tx.block_number)
    ? tx.block_number
    : typeof tx.block_number === "string" && /^\d+$/u.test(tx.block_number) ? Number(tx.block_number) : null;
  const confirmations = Number.isSafeInteger(tx.confirmations)
    ? tx.confirmations
    : typeof tx.confirmations === "string" && /^\d+$/u.test(tx.confirmations) ? Number(tx.confirmations) : null;
  const from = address(tx.from);
  const to = address(tx.to);
  const status = typeof tx.status === "string" ? tx.status.toLowerCase() : null;
  const valueAtomic = typeof tx.value === "string" && /^\d+$/u.test(tx.value) ? tx.value : null;
  const selector = rawInput && /^0x(?:[0-9a-f]{2}){4,}$/u.test(rawInput) ? rawInput.slice(0, 10) : null;
  if (observedHash !== txHash || blockNumber === null || confirmations === null || !from || !to
    || !new Set(["ok", "success", "error", "failed"]).has(status) || valueAtomic === null
    || selector === null) {
    throw new Error("BLOCKSCOUT_TRANSACTION_SCHEMA_INCOMPLETE");
  }
  return {
    txHash: observedHash,
    status,
    blockNumber,
    confirmations,
    from,
    to,
    valueAtomic,
    selector,
  };
}

export function compactLogs(payload, expectedAddress, expectedTopic) {
  const root = unwrap(payload);
  if (!Array.isArray(root.items)) throw new Error("BLOCKSCOUT_LOG_ENVELOPE_INVALID");
  const matching = root.items.map((entry) => {
    const log = object(entry);
    const topics = Array.isArray(log.topics)
      ? log.topics.filter((topic) => typeof topic === "string").slice(0, 4).map((topic) => topic.toLowerCase())
      : [];
    return {
      address: address(log.address),
      logIndex: Number.isSafeInteger(log.index) ? log.index : null,
      eventTopic: topics[0] ?? null,
      taskId: topics[1] ?? null,
      requestRef: topics[2] ?? null,
    };
  }).filter((log) => log.address === expectedAddress && log.eventTopic === expectedTopic);
  if (matching.length === 0) throw new Error("BLOCKSCOUT_TARGET_EVENT_MISSING");
  return matching.slice(0, 20);
}

export async function main(argv = process.argv.slice(2)) {
  const [txHashInput, chainIdInput, contractInput, eventTopicInput] = argv;
  if (!txHashInput || !TX_HASH.test(txHashInput) || !chainIdInput || !/^\d+$/u.test(chainIdInput)
    || !contractInput || !ADDRESS.test(contractInput) || !eventTopicInput || !TOPIC.test(eventTopicInput)) {
    usage();
    return;
  }
  const txHash = txHashInput.toLowerCase();
  const chainId = Number(chainIdInput);
  const contractAddress = contractInput.toLowerCase();
  const eventTopic = eventTopicInput.toLowerCase();
  await call("unlock_blockchain_analysis");
  const [transaction, logs] = await Promise.all([
    call("get_transaction_info", { chain_id: chainId, transaction_hash: txHash, include_raw_input: true }),
    call("direct_api_call", {
      chain_id: chainId,
      endpoint_path: `/api/v2/transactions/${txHash}/logs`,
    }),
  ]);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    source: "blockscout-mcp",
    chainId,
    transaction: compactTransaction(transaction, txHash),
    logs: compactLogs(logs, contractAddress, eventTopic),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
