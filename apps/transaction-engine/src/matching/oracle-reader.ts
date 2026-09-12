import { Contract, FetchRequest, JsonRpcProvider, keccak256 } from "ethers";
import type { VrfBinding } from "../chain/vrf-selection-binding";

export interface OracleSelectionEvidence {
  taskKey: string; commitment: string; requestId: string; randomWord: string; agentId: string;
  chainId: number; selectorAddress: string; coordinatorAddress: string;
  blockNumber: number; blockHash: string; confirmations: number;
  selectorCodeHash: string; coordinatorCodeHash: string;
}
export interface VrfOracleReader {
  read(binding: VrfBinding): Promise<OracleSelectionEvidence | null>;
}
const abi = [
  "function coordinator() view returns(address)",
  "function selections(bytes32) view returns(bytes32 commitment,bytes32 policyVersion,bytes32 eligibilityCommitment,uint256 totalWeight,uint256 requestId,uint256 requestedAt,uint256 randomWord,bytes32 selectedAgent,uint8 state)",
];
/** Read-only external gate. No wallet, signer, subscription or transaction API.
 * Pin both deployed runtime bytecodes from independently checked deployment evidence.
 * An absent configuration must never be substituted with synthetic addresses/code hashes.
 */
export class JsonRpcVrfOracleReader implements VrfOracleReader {
  private readonly provider: JsonRpcProvider;
  constructor(url: string, private readonly selectorCodeHash: string,
    private readonly coordinatorCodeHash: string, private readonly confirmations = 12) {
    if (!/^0x[0-9a-f]{64}$/iu.test(selectorCodeHash) || !/^0x[0-9a-f]{64}$/iu.test(coordinatorCodeHash)
      || !Number.isSafeInteger(confirmations) || confirmations < 3) throw new Error("VRF_ORACLE_CONFIG_INVALID");
    const request=new FetchRequest(url);request.timeout=8000;
    this.provider = new JsonRpcProvider(request);
  }
  async read(b: VrfBinding): Promise<OracleSelectionEvidence | null> {
    const network = await this.provider.getNetwork();
    if (network.chainId !== BigInt(b.chainId)) throw new Error("VRF_ORACLE_CHAIN_MISMATCH");
    const head = await this.provider.getBlockNumber();
    const blockNumber = head - this.confirmations + 1;
    if (blockNumber < 0) return null;
    const block = await this.provider.getBlock(blockNumber);
    if (!block?.hash) return null;
    const [selectorCode, coordinatorCode] = await Promise.all([
      this.provider.getCode(b.selectorAddress,blockNumber),this.provider.getCode(b.coordinatorAddress,blockNumber),
    ]);
    if (keccak256(selectorCode).toLowerCase() !== this.selectorCodeHash.toLowerCase()
      || keccak256(coordinatorCode).toLowerCase() !== this.coordinatorCodeHash.toLowerCase()) throw new Error("VRF_ORACLE_CODE_MISMATCH");
    const contract = new Contract(b.selectorAddress,abi,this.provider);
    const [coordinator,selection] = await Promise.all([
      contract.getFunction("coordinator").staticCall({blockTag:blockNumber}),
      contract.getFunction("selections").staticCall(b.taskFingerprint,{blockTag:blockNumber}),
    ]);
    if (String(coordinator).toLowerCase()!==b.coordinatorAddress) throw new Error("VRF_ORACLE_COORDINATOR_MISMATCH");
    const state = Number(selection.state);
    if (state<3) return null;
    if (state>4 || selection.commitment!==b.commitment || selection.policyVersion!==b.policyVersion
      || selection.eligibilityCommitment!==b.eligibilityCommitment || selection.requestId<=0n) throw new Error("VRF_ORACLE_BINDING_MISMATCH");
    const total=b.candidates.reduce((sum,c)=>sum+BigInt(c.weight),0n);
    if(selection.totalWeight!==total) throw new Error("VRF_ORACLE_POOL_MISMATCH");
    let ticket=selection.randomWord % total;
    const winner=b.candidates.find(c=>{if(ticket<BigInt(c.weight))return true;ticket-=BigInt(c.weight);return false;});
    if(!winner || (state===4 && selection.selectedAgent!==winner.agentKey)) throw new Error("VRF_ORACLE_WINNER_MISMATCH");
    // A fresh RPC call, not the provider's short-lived getBlock cache, checks canonicality again.
    const canonical=await this.provider.send("eth_getBlockByNumber",[`0x${blockNumber.toString(16)}`,false]);
    if(canonical?.hash!==block.hash) throw new Error("VRF_ORACLE_REORG");
    return {taskKey:b.taskKey,commitment:b.commitment,requestId:String(selection.requestId),randomWord:String(selection.randomWord),agentId:winner.agentId,
      chainId:b.chainId,selectorAddress:b.selectorAddress,coordinatorAddress:b.coordinatorAddress,
      blockNumber,blockHash:block.hash,confirmations:this.confirmations,selectorCodeHash:this.selectorCodeHash,coordinatorCodeHash:this.coordinatorCodeHash};
  }
}
