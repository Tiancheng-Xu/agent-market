import { AbiCoder, getAddress, id, keccak256 } from "ethers";
import type { MatchRequestedV1 } from "@agent-market/shared-contracts";
import type { TaskSnapshot } from "../domain/tasks";

/** Server-side adapter input, never an HTTP callback or browser-supplied eligibility claim. */
export interface VrfBindingInput {
  task: Pick<TaskSnapshot, "id" | "version" | "status">;
  match: Pick<MatchRequestedV1, "taskId" | "eventId" | "requestId" | "matchJobId" | "modelVersion">;
  pool: {
    taskId: string; taskRevision: number; revision: number;
    policyVersion: string; modelVersion: string; evidenceDigest: string;
    /** Qualified, model-deduplicated pool from the existing ranking/admission policy. */
    candidates: Array<{ agentId: string; weight: number }>;
  };
}
export interface VrfBindingConfig {
  namespace: string; chainId: number; selectorAddress: string; coordinatorAddress: string;
}
export interface VrfBinding extends VrfBindingConfig {
  taskKey: string; taskId: string; taskFingerprint: string; taskRevision: number;
  poolRevision: number; poolDigest: string; policyVersion: string;
  eligibilityCommitment: string; commitment: string;
  candidates: Array<{ agentId: string; agentKey: string; weight: number }>;
}
export interface VrfCallback {
  taskKey: string; taskFingerprint: string; taskRevision: number; poolRevision: number;
  poolDigest: string; policyVersion: string; commitment: string;
  chainId: number; selectorAddress: string; coordinatorAddress: string;
  requestId: string; randomWord: string; selectedAgentId: string;
}
export interface VrfBindingRecord {
  binding: VrfBinding;
  phase: "awaiting_request" | "awaiting_oracle" | "callback_bound";
  requestId: string | null;
  /** Quarantined data only: binding validation is not proof of oracle authenticity. */
  candidateResult: { agentId: string; randomWord: string } | null;
}
export interface VrfBindingStore {
  insert(record: VrfBindingRecord): Promise<boolean>;
  read(taskKey: string): Promise<{ version: number; record: VrfBindingRecord } | null>;
  compareAndSet(taskKey: string, expectedVersion: number, record: VrfBindingRecord): Promise<boolean>;
}
export interface VrfSelectionView {
  taskId: string; taskRevision: number; poolRevision: number; poolDigest: string;
  commitment: string; requestId: string | null;
  phase: VrfBindingRecord["phase"];
  status: "pending"; oracleEvidence: "pending"; fairnessVerified: false;
  selectedAgentId: null;
  pendingReason: "request-not-observed" | "oracle-fulfillment-unverified";
}
const abi = AbiCoder.defaultAbiCoder();
const digest = (types: string[], values: unknown[]) => keccak256(abi.encode(types, values));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value;
const revision = (value: number) => Number.isSafeInteger(value) && value > 0;
const uint256 = (value: string, zeroAllowed: boolean) => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/u.test(value)
  && BigInt(value) < (1n << 256n) && (zeroAllowed || BigInt(value) > 0n);

export function prepareVrfBinding(config: VrfBindingConfig, input: VrfBindingInput): VrfBinding {
  try {
    const { task, match, pool } = input;
    if (!text(config.namespace) || !revision(config.chainId) || !text(task.id)
      || task.status !== "matching" || !revision(task.version) || !revision(pool.revision)
      || match.taskId !== task.id || pool.taskId !== task.id || pool.taskRevision !== task.version
      || pool.modelVersion !== match.modelVersion || !text(pool.modelVersion) || !text(pool.policyVersion)
      || ![match.eventId, match.requestId, match.matchJobId].every(text)
      || !/^0x[0-9a-fA-F]{64}$/u.test(pool.evidenceDigest) || /^0x0{64}$/u.test(pool.evidenceDigest)
      || pool.candidates.length < 1 || pool.candidates.length > 128) throw new Error();
    const selectorAddress = getAddress(config.selectorAddress).toLowerCase();
    const coordinatorAddress = getAddress(config.coordinatorAddress).toLowerCase();
    if ([selectorAddress, coordinatorAddress].includes("0x" + "0".repeat(40))) throw new Error();
    const seen = new Set<string>();
    const candidates = pool.candidates.map((c) => {
      if (!text(c.agentId) || seen.has(c.agentId) || !revision(c.weight) || c.weight > 0xffffffff) throw new Error();
      seen.add(c.agentId);
      return { agentId: c.agentId, agentKey: digest(["bytes32", "string"], [id("AGENT_MARKET_AGENT_V1"), c.agentId]), weight: c.weight };
    }).sort((a, b) => a.agentKey < b.agentKey ? -1 : a.agentKey > b.agentKey ? 1 : 0);
    // Neither revisions nor deployment nor matching round can create a second logical draw.
    const taskKey = digest(["bytes32", "string", "string"], [id("AGENT_MARKET_TASK_V1"), config.namespace, task.id]);
    const poolDigest = digest(["bytes32", "tuple(bytes32 agentId,uint32 weight,bool eligible)[]"],
      [id("AGENT_MARKET_QUALIFIED_POOL_V1"), candidates.map((c) => [c.agentKey, c.weight, true])]);
    const policyVersion = digest(["bytes32", "string", "string"], [id("AGENT_MARKET_POLICY_V1"), pool.policyVersion, pool.modelVersion]);
    const eligibilityCommitment = digest(
      ["bytes32", "bytes32", "uint256", "uint256", "bytes32", "bytes32", "string", "string", "string"],
      [id("AGENT_MARKET_ELIGIBILITY_V1"), taskKey, task.version, pool.revision, poolDigest, pool.evidenceDigest, match.eventId, match.requestId, match.matchJobId],
    );
    const commitment = digest(
      ["bytes32", "uint256", "address", "bytes32", "bytes32", "bytes32", "tuple(bytes32 agentId,uint32 weight,bool eligible)[]"],
      [id("AGENT_MARKET_EXPLORATION_V1"), config.chainId, selectorAddress, taskKey, policyVersion, eligibilityCommitment, candidates.map((c) => [c.agentKey, c.weight, true])],
    );
    return { namespace: config.namespace, chainId: config.chainId, selectorAddress, coordinatorAddress,
      taskKey, taskId: task.id, taskFingerprint: taskKey, taskRevision: task.version,
      poolRevision: pool.revision, poolDigest, policyVersion, eligibilityCommitment, commitment, candidates };
  } catch { throw new Error("VRF_BINDING_INVALID"); }
}

/** No admin bypass, reroll, winner override, network access or transaction sending. */
export class VrfBindingAdapter {
  private readonly config: VrfBindingConfig;
  constructor(config: VrfBindingConfig, private readonly store: VrfBindingStore) {
    this.config = Object.freeze({ ...config });
  }
  async freeze(current: VrfBindingInput): Promise<VrfBinding> {
    const binding = prepareVrfBinding(this.config, current);
    if (!await this.store.insert({ binding, phase: "awaiting_request", requestId: null, candidateResult: null })) {
      throw new Error("VRF_REROLL_FORBIDDEN");
    }
    return binding;
  }
  private async load(current: VrfBindingInput) {
    const binding = prepareVrfBinding(this.config, current);
    const stored = await this.store.read(binding.taskKey);
    if (!stored) throw new Error("VRF_BINDING_MISSING");
    if (stored.record.binding.commitment !== binding.commitment
      || stored.record.binding.coordinatorAddress !== binding.coordinatorAddress) throw new Error("VRF_BINDING_STALE");
    return stored;
  }
  /** Records a request ID claim. Authentic request receipt readback remains a separate gate. */
  async bindRequest(current: VrfBindingInput, requestId: string): Promise<void> {
    if (!uint256(requestId, false)) throw new Error("VRF_REQUEST_INVALID");
    const { version, record } = await this.load(current);
    if (record.phase !== "awaiting_request") throw new Error("VRF_REROLL_FORBIDDEN");
    const next: VrfBindingRecord = { ...record, phase: "awaiting_oracle", requestId };
    if (!await this.store.compareAndSet(record.binding.taskKey, version, next)) throw new Error("VRF_REROLL_FORBIDDEN");
  }
  /** Quarantines a bound callback claim. MUST NOT be exposed directly as an unauthenticated route. */
  async recordCallback(current: VrfBindingInput, callback: VrfCallback): Promise<void> {
    const { version, record } = await this.load(current);
    if (record.phase !== "awaiting_oracle") throw new Error("VRF_REPLAY_FORBIDDEN");
    const b = record.binding;
    if (["taskKey", "taskFingerprint", "taskRevision", "poolRevision", "poolDigest", "policyVersion", "commitment", "chainId"]
      .some((key) => callback[key as keyof VrfCallback] !== b[key as keyof VrfBinding])
      || callback.selectorAddress.toLowerCase() !== b.selectorAddress
      || callback.coordinatorAddress.toLowerCase() !== b.coordinatorAddress
      || callback.requestId !== record.requestId || !uint256(callback.randomWord, true)) throw new Error("VRF_CALLBACK_INVALID");
    let ticket = BigInt(callback.randomWord) % b.candidates.reduce((sum, c) => sum + BigInt(c.weight), 0n);
    const winner = b.candidates.find((c) => {
      if (ticket < BigInt(c.weight)) return true;
      ticket -= BigInt(c.weight); return false;
    });
    if (!winner || winner.agentId !== callback.selectedAgentId) throw new Error("VRF_CALLBACK_INVALID");
    const next: VrfBindingRecord = { ...record, phase: "callback_bound", candidateResult: { agentId: winner.agentId, randomWord: callback.randomWord } };
    if (!await this.store.compareAndSet(b.taskKey, version, next)) throw new Error("VRF_REPLAY_FORBIDDEN");
  }
  async view(current: VrfBindingInput): Promise<VrfSelectionView> {
    const { record } = await this.load(current);
    const b = record.binding;
    return { taskId: b.taskId, taskRevision: b.taskRevision, poolRevision: b.poolRevision, poolDigest: b.poolDigest,
      commitment: b.commitment, requestId: record.requestId, phase: record.phase,
      status: "pending", oracleEvidence: "pending", fairnessVerified: false, selectedAgentId: null,
      pendingReason: record.phase === "awaiting_request" ? "request-not-observed" : "oracle-fulfillment-unverified" };
  }
}
