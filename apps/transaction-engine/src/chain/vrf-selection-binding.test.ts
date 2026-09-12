import { PGlite } from "@electric-sql/pglite";
import { AbiCoder, id, keccak256 } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import { VrfBindingAdapter, prepareVrfBinding, type VrfBindingInput } from "./vrf-selection-binding";
import { SqlVrfBindingStore } from "./vrf-selection-binding-store";
const config = { namespace: "agent-market-exploration", chainId: 11155111, selectorAddress: "0x1111111111111111111111111111111111111111", coordinatorAddress: "0x2222222222222222222222222222222222222222" };
const input = (): VrfBindingInput => ({
  task: { id: "task-1", version: 7, status: "matching" },
  match: { taskId: "task-1", eventId: "event-1", requestId: "request-1", matchJobId: "match-1", modelVersion: "model-v1" },
  pool: { taskId: "task-1", taskRevision: 7, revision: 3, policyVersion: "qualified-v1", modelVersion: "model-v1", evidenceDigest: id("qualification"), candidates: [{ agentId: "agent-a", weight: 1 }, { agentId: "agent-b", weight: 3 }] },
});
const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });
async function fixture() {
  const db = new PGlite(); databases.push(db);
  const store = new SqlVrfBindingStore(db); await store.initialize();
  return { store, adapter: new VrfBindingAdapter(config, store) };
}
function callback() {
  const b = prepareVrfBinding(config, input());
  return { taskKey: b.taskKey, taskFingerprint: b.taskFingerprint, taskRevision: b.taskRevision, poolRevision: b.poolRevision, poolDigest: b.poolDigest, commitment: b.commitment, policyVersion: b.policyVersion, chainId: config.chainId, selectorAddress: config.selectorAddress, coordinatorAddress: config.coordinatorAddress, requestId: "123", randomWord: "0", selectedAgentId: b.candidates[0]!.agentId };
}
describe("strict VRF binding (synthetic evidence only)", () => {
  it("matches Solidity commitment and canonicalizes pool enumeration", () => {
    const b = prepareVrfBinding(config, input());
    const reordered = input(); reordered.pool.candidates.reverse();
    expect(prepareVrfBinding(config, reordered)).toEqual(b);
    expect(b.commitment).toBe(keccak256(AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32", "bytes32", "bytes32", "tuple(bytes32 agentId,uint32 weight,bool eligible)[]"],
      [id("AGENT_MARKET_EXPLORATION_V1"), config.chainId, config.selectorAddress, b.taskFingerprint, b.policyVersion, b.eligibilityCommitment, b.candidates.map((c) => ({ agentId: c.agentKey, weight: c.weight, eligible: true }))],
    )));
  });
  it("binds task/pool revisions, candidate identity/weight, evidence, policy and match job", () => {
    const original = prepareVrfBinding(config, input());
    for (const change of [
      (v: VrfBindingInput) => { v.task.version++; v.pool.taskRevision++; },
      (v: VrfBindingInput) => { v.pool.revision++; },
      (v: VrfBindingInput) => { v.pool.candidates[0]!.weight++; },
      (v: VrfBindingInput) => { v.pool.candidates[0]!.agentId = "other-agent"; },
      (v: VrfBindingInput) => { v.pool.evidenceDigest = id("other"); },
      (v: VrfBindingInput) => { v.pool.policyVersion = "v2"; },
      (v: VrfBindingInput) => { v.match.matchJobId = "job-2"; },
    ]) {
      const value = input(); change(value); const next = prepareVrfBinding(config, value);
      expect(next.taskKey).toBe(original.taskKey);
      expect(next.taskFingerprint).toBe(original.taskFingerprint);
      expect(next.commitment).not.toBe(original.commitment);
    }
  });
  it("rejects stale task/pool provenance and invalid qualified pools", () => {
    for (const change of [
      (v: VrfBindingInput) => { v.task.status = "assigned"; },
      (v: VrfBindingInput) => { v.match.taskId = "other"; },
      (v: VrfBindingInput) => { v.pool.taskId = "other"; },
      (v: VrfBindingInput) => { v.pool.taskRevision--; },
      (v: VrfBindingInput) => { v.pool.modelVersion = "other"; },
      (v: VrfBindingInput) => { v.pool.candidates = []; },
      (v: VrfBindingInput) => { v.pool.candidates[0]!.weight = 0; },
      (v: VrfBindingInput) => { v.pool.candidates[0]!.weight = 0.5; },
      (v: VrfBindingInput) => { v.pool.candidates[0]!.weight = 4294967296; },
      (v: VrfBindingInput) => { v.pool.candidates[1]!.agentId = v.pool.candidates[0]!.agentId; },
      (v: VrfBindingInput) => { v.pool.evidenceDigest = "0x" + "0".repeat(64); },
    ]) { const value = input(); change(value); expect(() => prepareVrfBinding(config, value)).toThrow("VRF_BINDING_INVALID"); }
  });
  it("persists across adapter restart and refuses admin/revision/deployment rerolls", async () => {
    const { adapter, store } = await fixture(); await adapter.freeze(input());
    const restarted = new VrfBindingAdapter(config, store);
    await expect(restarted.freeze(input())).rejects.toThrow("VRF_REROLL_FORBIDDEN");
    const changed = input(); changed.task.version++; changed.pool.taskRevision++; changed.pool.revision++;
    await expect(restarted.freeze(changed)).rejects.toThrow("VRF_REROLL_FORBIDDEN");
    await expect(new VrfBindingAdapter({ ...config, selectorAddress: config.coordinatorAddress }, store).freeze(input())).rejects.toThrow("VRF_REROLL_FORBIDDEN");
  });
  it("atomically rejects concurrent freeze, request replacement and callback replay", async () => {
    const { adapter, store } = await fixture(); const other = new VrfBindingAdapter(config, store);
    const freezes = await Promise.allSettled([adapter.freeze(input()), other.freeze(input())]);
    expect(freezes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const requests = await Promise.allSettled([adapter.bindRequest(input(), "123"), other.bindRequest(input(), "124")]);
    expect(requests.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const data = { ...callback(), requestId: (await adapter.view(input())).requestId! };
    const callbacks = await Promise.allSettled([adapter.recordCallback(input(), data), other.recordCallback(input(), data)]);
    expect(callbacks.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(adapter.recordCallback(input(), data)).rejects.toThrow("VRF_REPLAY_FORBIDDEN");
  });
  it("rejects old callbacks against a changed current task or pool", async () => {
    const { adapter } = await fixture(); await adapter.freeze(input()); await adapter.bindRequest(input(), "123");
    for (const change of [
      (v: VrfBindingInput) => { v.pool.revision++; },
      (v: VrfBindingInput) => { v.pool.candidates[0]!.weight++; },
      (v: VrfBindingInput) => { v.task.version++; v.pool.taskRevision++; },
    ]) { const current = input(); change(current); await expect(adapter.recordCallback(current, callback())).rejects.toThrow("VRF_BINDING_STALE"); }
    expect((await adapter.view(input())).phase).toBe("awaiting_oracle");
  });
  it("rejects wrong binding/domain/request and ineligible or wrong weighted winners", async () => {
    const { adapter } = await fixture(); await adapter.freeze(input()); await adapter.bindRequest(input(), "123");
    for (const patch of [
      { taskKey: id("other") }, { taskFingerprint: id("other") }, { taskRevision: 8 }, { poolRevision: 4 },
      { poolDigest: id("other") }, { commitment: id("other") }, { policyVersion: id("other") },
      { requestId: "124" }, { chainId: 1 }, { coordinatorAddress: config.selectorAddress }, { selectorAddress: config.coordinatorAddress },
      { selectedAgentId: "not-qualified" }, { randomWord: "-1" }, { randomWord: (1n << 256n).toString() },
      { selectedAgentId: prepareVrfBinding(config, input()).candidates[1]!.agentId },
    ]) await expect(adapter.recordCallback(input(), { ...callback(), ...patch })).rejects.toThrow("VRF_CALLBACK_INVALID");
    expect((await adapter.view(input())).phase).toBe("awaiting_oracle");
  });
  it("never promotes synthetic randomness to verified fairness or a matching winner", async () => {
    const { adapter } = await fixture(); await adapter.freeze(input());
    expect((await adapter.view(input())).pendingReason).toBe("request-not-observed");
    await expect(adapter.bindRequest(input(), "0")).rejects.toThrow("VRF_REQUEST_INVALID");
    await adapter.bindRequest(input(), "123"); await adapter.recordCallback(input(), callback());
    expect(await adapter.view(input())).toMatchObject({ status: "pending", phase: "callback_bound", oracleEvidence: "pending", fairnessVerified: false, selectedAgentId: null, pendingReason: "oracle-fulfillment-unverified" });
    await expect(adapter.bindRequest(input(), "456")).rejects.toThrow("VRF_REROLL_FORBIDDEN");
  });
});
