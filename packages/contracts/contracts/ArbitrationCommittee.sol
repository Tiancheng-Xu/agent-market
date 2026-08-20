// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IArbitrationCallback {
    function resolveDispute(bytes32 taskId, bool agentWins) external;
}

contract ArbitrationCommittee is Ownable {
    struct CaseData {
        address escrow;
        address publisher;
        address agent;
        address[3] seats;
        uint8 publisherVotes;
        uint8 agentVotes;
        bool resolved;
    }

    address[] public members;
    uint256 public nextCursor;
    mapping(address escrow => bool authorized) public authorizedEscrows;
    mapping(bytes32 taskId => CaseData data) private cases;
    mapping(bytes32 taskId => mapping(address voter => bool voted)) public hasVoted;

    error UnauthorizedEscrow(address caller);
    error CaseAlreadyExists(bytes32 taskId);
    error CaseNotFound(bytes32 taskId);
    error InvalidMemberSet();
    error NotAssigned(address caller);
    error AlreadyVoted(address caller);
    error CaseResolved(bytes32 taskId);
    error NoReplacementAvailable();

    event EscrowAuthorizationUpdated(address indexed escrow, bool authorized);
    event CaseOpened(bytes32 indexed taskId, address indexed escrow, address[3] seats);
    event ConflictDeclared(bytes32 indexed taskId, address indexed member, address indexed replacement);
    event VoteCast(bytes32 indexed taskId, address indexed voter, bool agentWins);
    event RulingFormed(bytes32 indexed taskId, bool agentWins);

    constructor(address[] memory initialMembers) Ownable(msg.sender) {
        if (initialMembers.length < 5) revert InvalidMemberSet();
        for (uint256 i; i < initialMembers.length; ++i) {
            if (initialMembers[i] == address(0)) revert InvalidMemberSet();
            for (uint256 j; j < i; ++j) if (initialMembers[j] == initialMembers[i]) revert InvalidMemberSet();
            members.push(initialMembers[i]);
        }
    }

    function setAuthorizedEscrow(address escrow, bool authorized) external onlyOwner {
        authorizedEscrows[escrow] = authorized;
        emit EscrowAuthorizationUpdated(escrow, authorized);
    }

    function openCase(bytes32 taskId, address publisher, address agent) external {
        if (!authorizedEscrows[msg.sender]) revert UnauthorizedEscrow(msg.sender);
        if (cases[taskId].escrow != address(0)) revert CaseAlreadyExists(taskId);
        CaseData storage data = cases[taskId];
        data.escrow = msg.sender;
        data.publisher = publisher;
        data.agent = agent;
        for (uint256 seat; seat < 3; ++seat) data.seats[seat] = _nextEligible(data, address(0));
        emit CaseOpened(taskId, msg.sender, data.seats);
    }

    function declareConflict(bytes32 taskId) external {
        CaseData storage data = _openCase(taskId);
        uint256 seat = _seatOf(data, msg.sender);
        address replacement = _nextEligible(data, msg.sender);
        data.seats[seat] = replacement;
        emit ConflictDeclared(taskId, msg.sender, replacement);
    }

    function castVote(bytes32 taskId, bool agentWins) external {
        CaseData storage data = _openCase(taskId);
        _seatOf(data, msg.sender);
        if (hasVoted[taskId][msg.sender]) revert AlreadyVoted(msg.sender);
        hasVoted[taskId][msg.sender] = true;
        if (agentWins) data.agentVotes += 1; else data.publisherVotes += 1;
        emit VoteCast(taskId, msg.sender, agentWins);
        if (data.agentVotes == 2 || data.publisherVotes == 2) {
            data.resolved = true;
            bool finalAgentWins = data.agentVotes == 2;
            emit RulingFormed(taskId, finalAgentWins);
            IArbitrationCallback(data.escrow).resolveDispute(taskId, finalAgentWins);
        }
    }

    function getCase(bytes32 taskId) external view returns (CaseData memory) {
        if (cases[taskId].escrow == address(0)) revert CaseNotFound(taskId);
        return cases[taskId];
    }

    function _openCase(bytes32 taskId) private view returns (CaseData storage data) {
        data = cases[taskId];
        if (data.escrow == address(0)) revert CaseNotFound(taskId);
        if (data.resolved) revert CaseResolved(taskId);
    }

    function _seatOf(CaseData storage data, address member) private view returns (uint256) {
        for (uint256 i; i < 3; ++i) if (data.seats[i] == member) return i;
        revert NotAssigned(member);
    }

    function _nextEligible(CaseData storage data, address excluded) private returns (address) {
        uint256 length = members.length;
        for (uint256 attempts; attempts < length; ++attempts) {
            address candidate = members[nextCursor % length];
            nextCursor += 1;
            if (candidate == data.publisher || candidate == data.agent || candidate == excluded) continue;
            bool alreadySeated;
            for (uint256 i; i < 3; ++i) if (data.seats[i] == candidate) alreadySeated = true;
            if (!alreadySeated) return candidate;
        }
        revert NoReplacementAvailable();
    }
}
