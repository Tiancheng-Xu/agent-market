// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ICommittee {
    function openCase(bytes32 taskId, address publisher, address agent) external;
}

contract AgentMarketEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant YEAR = 365 days;
    uint256 public constant RATE_PERCENT = 6;
    uint256 public constant BOND_PERCENT = 6;

    enum TaskState { NONE, OPEN, ASSIGNED, IN_PROGRESS, SUBMITTED, DISPUTED, SETTLED, REFUNDED }

    struct TaskEscrow {
        address publisher;
        address agent;
        bytes32 requestRef;
        uint256 budget;
        uint256 bond;
        uint64 deadline;
        uint64 startedAt;
        TaskState state;
    }

    IERC20 public immutable yd;
    ICommittee public immutable committee;
    address public immutable platformTreasury;
    uint256 public rewardReserve;
    mapping(bytes32 taskId => TaskEscrow escrow) public tasks;
    mapping(bytes32 requestRef => bool used) public usedRequestRefs;

    error InvalidAmount();
    error InvalidDeadline();
    error InvalidState(TaskState actual);
    error Unauthorized(address caller);
    error TaskAlreadyExists(bytes32 taskId);
    error RequestRefAlreadyUsed(bytes32 requestRef);
    error InvalidReference();
    error InvalidTreasury();

    event RewardPoolFunded(address indexed funder, uint256 amount);
    event TaskCreated(bytes32 indexed taskId, bytes32 indexed requestRef, address indexed publisher, uint256 budget, uint64 deadline);
    event AgentAssigned(bytes32 indexed taskId, bytes32 indexed requestRef, address indexed agent);
    event TaskAccepted(bytes32 indexed taskId, bytes32 indexed requestRef, uint256 bond, uint64 startedAt);
    event WorkSubmitted(bytes32 indexed taskId, bytes32 indexed requestRef);
    event DisputeOpened(bytes32 indexed taskId, bytes32 indexed requestRef);
    event TaskSettled(bytes32 indexed taskId, bytes32 indexed requestRef, bool agentWins, uint256 budgetPaid, uint256 bondPaidToPlatform, uint256 yieldPaid, uint256 yieldShortfall);

    constructor(IERC20 token, ICommittee arbitration, address treasury) Ownable(msg.sender) {
        if (treasury == address(0)) revert InvalidTreasury();
        yd = token;
        committee = arbitration;
        platformTreasury = treasury;
    }

    function fundRewardPool(uint256 amount) external onlyOwner {
        if (amount == 0) revert InvalidAmount();
        rewardReserve += amount;
        yd.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardPoolFunded(msg.sender, amount);
    }

    function createTask(bytes32 taskId, bytes32 requestRef, uint256 budget, uint64 deadline) external nonReentrant {
        if (taskId == bytes32(0) || requestRef == bytes32(0)) revert InvalidReference();
        if (tasks[taskId].state != TaskState.NONE) revert TaskAlreadyExists(taskId);
        if (usedRequestRefs[requestRef]) revert RequestRefAlreadyUsed(requestRef);
        if (budget == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        usedRequestRefs[requestRef] = true;
        tasks[taskId] = TaskEscrow(msg.sender, address(0), requestRef, budget, 0, deadline, 0, TaskState.OPEN);
        yd.safeTransferFrom(msg.sender, address(this), budget);
        emit TaskCreated(taskId, requestRef, msg.sender, budget, deadline);
    }

    function assignAgent(bytes32 taskId, address agent) external {
        TaskEscrow storage task = tasks[taskId];
        _requireState(task, TaskState.OPEN);
        if (msg.sender != task.publisher || agent == address(0)) revert Unauthorized(msg.sender);
        task.agent = agent;
        task.state = TaskState.ASSIGNED;
        emit AgentAssigned(taskId, task.requestRef, agent);
    }

    function acceptTask(bytes32 taskId) external nonReentrant {
        TaskEscrow storage task = tasks[taskId];
        _requireState(task, TaskState.ASSIGNED);
        if (msg.sender != task.agent) revert Unauthorized(msg.sender);
        uint256 bond = task.budget * BOND_PERCENT / 100;
        task.bond = bond;
        task.startedAt = uint64(block.timestamp);
        task.state = TaskState.IN_PROGRESS;
        yd.safeTransferFrom(msg.sender, address(this), bond);
        emit TaskAccepted(taskId, task.requestRef, bond, task.startedAt);
    }

    function submitWork(bytes32 taskId) external {
        TaskEscrow storage task = tasks[taskId];
        _requireState(task, TaskState.IN_PROGRESS);
        if (msg.sender != task.agent) revert Unauthorized(msg.sender);
        task.state = TaskState.SUBMITTED;
        emit WorkSubmitted(taskId, task.requestRef);
    }

    function acceptWork(bytes32 taskId) external nonReentrant {
        TaskEscrow storage task = tasks[taskId];
        _requireState(task, TaskState.SUBMITTED);
        if (msg.sender != task.publisher) revert Unauthorized(msg.sender);
        _settle(taskId, task, true);
    }

    function timeoutTask(bytes32 taskId) external nonReentrant {
        TaskEscrow storage task = tasks[taskId];
        _requireState(task, TaskState.IN_PROGRESS);
        if (msg.sender != task.publisher) revert Unauthorized(msg.sender);
        if (block.timestamp <= task.deadline) revert InvalidDeadline();
        _settle(taskId, task, false);
    }

    function openDispute(bytes32 taskId) external {
        TaskEscrow storage task = tasks[taskId];
        if (task.state != TaskState.IN_PROGRESS && task.state != TaskState.SUBMITTED) revert InvalidState(task.state);
        if (msg.sender != task.publisher && msg.sender != task.agent) revert Unauthorized(msg.sender);
        task.state = TaskState.DISPUTED;
        committee.openCase(taskId, task.publisher, task.agent);
        emit DisputeOpened(taskId, task.requestRef);
    }

    function resolveDispute(bytes32 taskId, bool agentWins) external nonReentrant {
        if (msg.sender != address(committee)) revert Unauthorized(msg.sender);
        TaskEscrow storage task = tasks[taskId];
        _requireState(task, TaskState.DISPUTED);
        _settle(taskId, task, agentWins);
    }

    function pendingYield(bytes32 taskId) public view returns (uint256) {
        TaskEscrow memory task = tasks[taskId];
        if (task.startedAt == 0) return 0;
        return task.budget * RATE_PERCENT * (block.timestamp - task.startedAt) / (100 * YEAR);
    }

    function _settle(bytes32 taskId, TaskEscrow storage task, bool agentWins) private {
        uint256 dueYield = pendingYield(taskId);
        uint256 paidYield = dueYield > rewardReserve ? rewardReserve : dueYield;
        uint256 shortfall = dueYield - paidYield;
        rewardReserve -= paidYield;
        task.state = agentWins ? TaskState.SETTLED : TaskState.REFUNDED;
        address recipient = agentWins ? task.agent : task.publisher;
        yd.safeTransfer(recipient, task.budget + paidYield);
        yd.safeTransfer(platformTreasury, task.bond);
        emit TaskSettled(taskId, task.requestRef, agentWins, task.budget, task.bond, paidYield, shortfall);
    }

    function _requireState(TaskEscrow storage task, TaskState expected) private view {
        if (task.state != expected) revert InvalidState(task.state);
    }
}
