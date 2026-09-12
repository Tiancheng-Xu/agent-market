// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Minimal Chainlink VRF v2.5 subscription ABI; see docs/architecture/vrf-selection.md.
interface IExplorationVRFCoordinator {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }
    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256 requestId);
}

/// @notice Advisory qualified-agent exposure selection ONLY. Not arbitration or settlement.
/// @dev The freezer attests eligibility and canonical task identity. VRF cannot prove either.
contract VRFExplorationSelector {
    enum State { None, Frozen, Requested, RandomReady, Selected }
    struct Candidate { bytes32 agentId; uint32 weight; bool eligible; }
    struct Selection {
        bytes32 commitment;
        bytes32 policyVersion;
        bytes32 eligibilityCommitment;
        uint256 totalWeight;
        uint256 requestId;
        uint256 requestedAt;
        uint256 randomWord;
        bytes32 selectedAgent;
        State state;
    }

    error Unauthorized();
    error OnlyCoordinator();
    error InvalidConfig();
    error InvalidPool();
    error AlreadyFrozen();
    error InvalidState();
    error InvalidRequestId();

    event PoolFrozen(bytes32 indexed taskFingerprint, bytes32 indexed commitment, bytes32 policyVersion, bytes32 eligibilityCommitment);
    event SelectionRequested(bytes32 indexed taskFingerprint, uint256 indexed requestId, bytes32 commitment);
    event RandomnessReceived(bytes32 indexed taskFingerprint, uint256 indexed requestId, uint256 randomWord);
    event CallbackIgnored(uint256 indexed requestId);
    event AgentSelected(bytes32 indexed taskFingerprint, uint256 indexed requestId, bytes32 indexed agentId, bytes32 commitment);

    bytes32 public constant DOMAIN = keccak256("AGENT_MARKET_EXPLORATION_V1");
    uint256 public constant MAX_CANDIDATES = 128;
    address public immutable coordinator;
    address public immutable freezer;
    bytes32 public immutable keyHash;
    uint256 public immutable subscriptionId;
    uint16 public immutable requestConfirmations;
    uint32 public immutable callbackGasLimit;
    bool public immutable nativePayment;
    uint256 public immutable timeoutSeconds;

    mapping(bytes32 => Selection) public selections;
    mapping(bytes32 => Candidate[]) private pools;
    mapping(uint256 => bytes32) public requestTask;

    constructor(address coordinator_, address freezer_, bytes32 keyHash_, uint256 subscriptionId_,
        uint16 confirmations_, uint32 callbackGasLimit_, bool nativePayment_, uint256 timeoutSeconds_) {
        if (coordinator_.code.length == 0 || freezer_ == address(0) || keyHash_ == bytes32(0)
            || subscriptionId_ == 0 || confirmations_ < 3 || confirmations_ > 200
            || callbackGasLimit_ < 150000 || timeoutSeconds_ < 60 || timeoutSeconds_ > 30 days) revert InvalidConfig();
        coordinator = coordinator_;
        freezer = freezer_;
        keyHash = keyHash_;
        subscriptionId = subscriptionId_;
        requestConfirmations = confirmations_;
        callbackGasLimit = callbackGasLimit_;
        nativePayment = nativePayment_;
        timeoutSeconds = timeoutSeconds_;
    }

    /// @notice Freeze a canonical task ONCE, including rejected candidates and all weights.
    /// @dev IDs must be unique and ascending; rejected candidates have zero weight.
    function freeze(bytes32 taskFingerprint, bytes32 policyVersion, bytes32 eligibilityCommitment,
        Candidate[] calldata candidates) external {
        if (msg.sender != freezer) revert Unauthorized();
        Selection storage s = selections[taskFingerprint];
        if (s.state != State.None) revert AlreadyFrozen();
        if (taskFingerprint == bytes32(0) || policyVersion == bytes32(0) || eligibilityCommitment == bytes32(0)
            || candidates.length == 0 || candidates.length > MAX_CANDIDATES) revert InvalidPool();
        bytes32 previous;
        uint256 total;
        for (uint256 i; i < candidates.length; ++i) {
            Candidate calldata c = candidates[i];
            if (c.agentId <= previous || (c.eligible ? c.weight == 0 : c.weight != 0)) revert InvalidPool();
            previous = c.agentId;
            total += c.weight;
            pools[taskFingerprint].push(c);
        }
        if (total == 0) revert InvalidPool();
        s.commitment = keccak256(abi.encode(DOMAIN, block.chainid, address(this), taskFingerprint,
            policyVersion, eligibilityCommitment, candidates));
        s.policyVersion = policyVersion;
        s.eligibilityCommitment = eligibilityCommitment;
        s.totalWeight = total;
        s.state = State.Frozen;
        emit PoolFrozen(taskFingerprint, s.commitment, policyVersion, eligibilityCommitment);
    }

    /// @notice Anyone can progress a frozen draw; no caller-supplied randomness or parameters.
    function requestSelection(bytes32 taskFingerprint) external returns (uint256 requestId) {
        Selection storage s = selections[taskFingerprint];
        if (s.state != State.Frozen) revert InvalidState();
        s.state = State.Requested;
        s.requestedAt = block.timestamp;
        requestId = IExplorationVRFCoordinator(coordinator).requestRandomWords(
            IExplorationVRFCoordinator.RandomWordsRequest({
                keyHash: keyHash, subId: subscriptionId, requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit, numWords: 1,
                extraArgs: abi.encodeWithSelector(bytes4(keccak256("VRF ExtraArgsV1")), nativePayment)
            })
        );
        if (requestId == 0 || requestTask[requestId] != bytes32(0)) revert InvalidRequestId();
        requestTask[requestId] = taskFingerprint;
        s.requestId = requestId;
        emit SelectionRequested(taskFingerprint, requestId, s.commitment);
    }

    /// @notice Authenticated v2.5 entrypoint; constant work, no external calls or candidate iteration.
    /// @dev A late valid result remains binding. Unknown, duplicate and malformed callbacks are no-ops.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != coordinator) revert OnlyCoordinator();
        bytes32 taskFingerprint = requestTask[requestId];
        Selection storage s = selections[taskFingerprint];
        if (taskFingerprint == bytes32(0) || s.state != State.Requested || randomWords.length != 1) {
            emit CallbackIgnored(requestId);
            return;
        }
        s.randomWord = randomWords[0];
        s.state = State.RandomReady;
        emit RandomnessReceived(taskFingerprint, requestId, randomWords[0]);
    }

    /// @notice Anyone can finalize the same deterministic result; no expiry, alternatives or external effects.
    function finalize(bytes32 taskFingerprint) external returns (bytes32 selectedAgent) {
        Selection storage s = selections[taskFingerprint];
        if (s.state != State.RandomReady) revert InvalidState();
        uint256 ticket = s.randomWord % s.totalWeight;
        Candidate[] storage candidates = pools[taskFingerprint];
        for (uint256 i; i < candidates.length; ++i) {
            Candidate storage c = candidates[i];
            if (!c.eligible) continue;
            if (ticket < c.weight) {
                selectedAgent = c.agentId;
                s.selectedAgent = selectedAgent;
                s.state = State.Selected;
                emit AgentSelected(taskFingerprint, s.requestId, selectedAgent, s.commitment);
                return selectedAgent;
            }
            ticket -= c.weight;
        }
        // Unreachable for a validated, immutable, positive-weight pool.
        revert InvalidPool();
    }

    /// @notice Operational signal ONLY. Never cancels, expires or unlocks a replacement draw.
    function isOverdue(bytes32 taskFingerprint) external view returns (bool) {
        Selection storage s = selections[taskFingerprint];
        return s.state == State.Requested && block.timestamp >= s.requestedAt + timeoutSeconds;
    }

    function getPool(bytes32 taskFingerprint) external view returns (Candidate[] memory) {
        return pools[taskFingerprint];
    }
}
