// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITaskStakeReceipt {
    function mint(address participant, uint256 receiptId) external;
    function burn(uint256 receiptId) external;
    function ownerOf(uint256 receiptId) external view returns (address);
}

contract AgentMarketWorkflowEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PUBLICATION_FEE_PERCENT = 6;
    uint16 public constant TOTAL_SHARE_BPS = 10_000;

    enum TaskState { NONE, OPEN, IN_PROGRESS, DISPUTED, SETTLED_AGENTS, SETTLED_PUBLISHER, CANCELLED }

    struct Task {
        address publisher;
        bytes32 requestRef;
        bytes32 workflowId;
        bytes32 dagHash;
        uint256 budget;
        uint256 publicationFee;
        uint64 deadline;
        uint32 workflowVersion;
        uint16 assignedShareBps;
        uint16 acceptedShareBps;
        TaskState state;
    }

    struct NodeAssignment {
        address agent;
        uint256 stakeAmount;
        uint256 receiptId;
        uint16 shareBps;
        bool accepted;
        bool stakeClaimed;
    }

    IERC20 public immutable yd;
    ITaskStakeReceipt public immutable stakeReceipt;
    address public immutable platformTreasury;
    address public immutable platformArbiter;

    mapping(bytes32 taskId => Task task) public tasks;
    mapping(bytes32 taskId => mapping(bytes32 nodeId => NodeAssignment assignment)) public assignments;
    mapping(bytes32 taskId => bytes32[] nodeIds) private taskNodes;
    mapping(bytes32 requestRef => bool used) public usedRequestRefs;
    mapping(uint256 receiptId => bytes32 taskId) public receiptTasks;
    mapping(uint256 receiptId => bytes32 nodeId) public receiptNodes;

    error InvalidAmount();
    error InvalidReference();
    error InvalidDeadline();
    error InvalidAddress();
    error InvalidState(TaskState actual);
    error Unauthorized(address caller);
    error TaskAlreadyExists(bytes32 taskId);
    error RequestRefAlreadyUsed(bytes32 requestRef);
    error InvalidWorkflowVersion(uint32 expected, uint32 actual);
    error ShareLimitExceeded();
    error AssignmentAlreadyExists(bytes32 nodeId);
    error AssignmentNotAccepted(bytes32 nodeId);
    error InvalidReceipt(uint256 receiptId);
    error StakeNotClaimable();

    event TaskCreated(bytes32 indexed taskId, bytes32 indexed requestRef, address indexed publisher, uint256 budget, uint256 publicationFee, uint64 deadline);
    event WorkflowAnchored(bytes32 indexed taskId, bytes32 indexed workflowId, bytes32 dagHash, uint32 version);
    event NodeAssigned(bytes32 indexed taskId, bytes32 indexed nodeId, address indexed agent, uint256 stakeAmount, uint16 shareBps);
    event NodeAccepted(bytes32 indexed taskId, bytes32 indexed nodeId, address indexed agent, uint256 receiptId, uint256 stakeAmount);
    event DisputeOpened(bytes32 indexed taskId, address indexed openedBy);
    event TaskResolved(bytes32 indexed taskId, bool agentsWin, address indexed arbiter, uint256 budget);
    event StakeClaimed(bytes32 indexed taskId, bytes32 indexed nodeId, address indexed agent, uint256 receiptId, uint256 amount);
    event TaskCancelled(bytes32 indexed taskId, uint256 budgetReturned, uint256 publicationFeeRetained);

    constructor(IERC20 token, ITaskStakeReceipt receipt, address treasury, address arbiter) {
        if (address(token) == address(0) || address(receipt) == address(0) || treasury == address(0) || arbiter == address(0)) revert InvalidAddress();
        yd = token;
        stakeReceipt = receipt;
        platformTreasury = treasury;
        platformArbiter = arbiter;
    }

    function createTask(bytes32 taskId, bytes32 requestRef, uint256 budget, uint64 deadline) external nonReentrant {
        if (taskId == bytes32(0) || requestRef == bytes32(0)) revert InvalidReference();
        if (tasks[taskId].state != TaskState.NONE) revert TaskAlreadyExists(taskId);
        if (usedRequestRefs[requestRef]) revert RequestRefAlreadyUsed(requestRef);
        if (budget == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        uint256 publicationFee = budget * PUBLICATION_FEE_PERCENT / 100;
        usedRequestRefs[requestRef] = true;
        tasks[taskId] = Task(msg.sender, requestRef, bytes32(0), bytes32(0), budget, publicationFee, deadline, 0, 0, 0, TaskState.OPEN);
        yd.safeTransferFrom(msg.sender, address(this), budget + publicationFee);
        yd.safeTransfer(platformTreasury, publicationFee);
        emit TaskCreated(taskId, requestRef, msg.sender, budget, publicationFee, deadline);
    }

    function anchorWorkflow(bytes32 taskId, bytes32 workflowId, bytes32 dagHash, uint32 version) external {
        Task storage task = tasks[taskId];
        _requireState(task, TaskState.OPEN);
        if (msg.sender != task.publisher && msg.sender != platformArbiter) revert Unauthorized(msg.sender);
        if (workflowId == bytes32(0) || dagHash == bytes32(0)) revert InvalidReference();
        uint32 expected = task.workflowVersion + 1;
        if (version != expected) revert InvalidWorkflowVersion(expected, version);
        task.workflowId = workflowId;
        task.dagHash = dagHash;
        task.workflowVersion = version;
        emit WorkflowAnchored(taskId, workflowId, dagHash, version);
    }

    function assignNode(bytes32 taskId, bytes32 nodeId, address agent, uint256 stakeAmount, uint16 shareBps) external {
        Task storage task = tasks[taskId];
        _requireState(task, TaskState.OPEN);
        if (msg.sender != task.publisher && msg.sender != platformArbiter) revert Unauthorized(msg.sender);
        if (nodeId == bytes32(0) || agent == address(0) || stakeAmount == 0 || shareBps == 0) revert InvalidAmount();
        if (assignments[taskId][nodeId].agent != address(0)) revert AssignmentAlreadyExists(nodeId);
        if (uint256(task.assignedShareBps) + shareBps > TOTAL_SHARE_BPS) revert ShareLimitExceeded();
        task.assignedShareBps += shareBps;
        assignments[taskId][nodeId] = NodeAssignment(agent, stakeAmount, 0, shareBps, false, false);
        taskNodes[taskId].push(nodeId);
        emit NodeAssigned(taskId, nodeId, agent, stakeAmount, shareBps);
    }

    function acceptNode(bytes32 taskId, bytes32 nodeId) external nonReentrant returns (uint256 receiptId) {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.OPEN && task.state != TaskState.IN_PROGRESS) revert InvalidState(task.state);
        NodeAssignment storage assignment = assignments[taskId][nodeId];
        if (assignment.agent != msg.sender) revert Unauthorized(msg.sender);
        if (assignment.accepted) revert AssignmentAlreadyExists(nodeId);
        receiptId = uint256(keccak256(abi.encode(taskId, nodeId, msg.sender)));
        assignment.accepted = true;
        assignment.receiptId = receiptId;
        task.acceptedShareBps += assignment.shareBps;
        task.state = TaskState.IN_PROGRESS;
        receiptTasks[receiptId] = taskId;
        receiptNodes[receiptId] = nodeId;
        yd.safeTransferFrom(msg.sender, address(this), assignment.stakeAmount);
        stakeReceipt.mint(msg.sender, receiptId);
        emit NodeAccepted(taskId, nodeId, msg.sender, receiptId, assignment.stakeAmount);
    }

    function openDispute(bytes32 taskId) external {
        Task storage task = tasks[taskId];
        _requireState(task, TaskState.IN_PROGRESS);
        if (msg.sender != task.publisher && !_isAcceptedAgent(taskId, msg.sender)) revert Unauthorized(msg.sender);
        task.state = TaskState.DISPUTED;
        emit DisputeOpened(taskId, msg.sender);
    }

    function resolveTask(bytes32 taskId, bool agentsWin) external nonReentrant {
        if (msg.sender != platformArbiter) revert Unauthorized(msg.sender);
        Task storage task = tasks[taskId];
        if (task.state != TaskState.IN_PROGRESS && task.state != TaskState.DISPUTED) revert InvalidState(task.state);
        if (agentsWin && task.acceptedShareBps != TOTAL_SHARE_BPS) revert ShareLimitExceeded();
        if (agentsWin) {
            task.state = TaskState.SETTLED_AGENTS;
            for (uint256 i; i < taskNodes[taskId].length; ++i) {
                NodeAssignment storage assignment = assignments[taskId][taskNodes[taskId][i]];
                if (!assignment.accepted) revert AssignmentNotAccepted(taskNodes[taskId][i]);
                yd.safeTransfer(assignment.agent, task.budget * assignment.shareBps / TOTAL_SHARE_BPS);
            }
        } else {
            task.state = TaskState.SETTLED_PUBLISHER;
            yd.safeTransfer(task.publisher, task.budget);
            for (uint256 i; i < taskNodes[taskId].length; ++i) {
                NodeAssignment storage assignment = assignments[taskId][taskNodes[taskId][i]];
                if (assignment.accepted && !assignment.stakeClaimed) {
                    assignment.stakeClaimed = true;
                    stakeReceipt.burn(assignment.receiptId);
                    yd.safeTransfer(platformTreasury, assignment.stakeAmount);
                }
            }
        }
        emit TaskResolved(taskId, agentsWin, msg.sender, task.budget);
    }

    function claimStake(uint256 receiptId) external nonReentrant {
        bytes32 taskId = receiptTasks[receiptId];
        bytes32 nodeId = receiptNodes[receiptId];
        if (taskId == bytes32(0) || nodeId == bytes32(0)) revert InvalidReceipt(receiptId);
        Task storage task = tasks[taskId];
        if (task.state != TaskState.SETTLED_AGENTS) revert StakeNotClaimable();
        NodeAssignment storage assignment = assignments[taskId][nodeId];
        if (assignment.stakeClaimed || stakeReceipt.ownerOf(receiptId) != msg.sender) revert Unauthorized(msg.sender);
        assignment.stakeClaimed = true;
        stakeReceipt.burn(receiptId);
        yd.safeTransfer(msg.sender, assignment.stakeAmount);
        emit StakeClaimed(taskId, nodeId, msg.sender, receiptId, assignment.stakeAmount);
    }

    function cancelBeforeStart(bytes32 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        _requireState(task, TaskState.OPEN);
        if (msg.sender != task.publisher) revert Unauthorized(msg.sender);
        task.state = TaskState.CANCELLED;
        yd.safeTransfer(task.publisher, task.budget);
        emit TaskCancelled(taskId, task.budget, task.publicationFee);
    }

    function getTaskNodeIds(bytes32 taskId) external view returns (bytes32[] memory) {
        return taskNodes[taskId];
    }

    function _isAcceptedAgent(bytes32 taskId, address participant) private view returns (bool) {
        for (uint256 i; i < taskNodes[taskId].length; ++i) {
            NodeAssignment storage assignment = assignments[taskId][taskNodes[taskId][i]];
            if (assignment.agent == participant && assignment.accepted) return true;
        }
        return false;
    }

    function _requireState(Task storage task, TaskState expected) private view {
        if (task.state != expected) revert InvalidState(task.state);
    }
}
