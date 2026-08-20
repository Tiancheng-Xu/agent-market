// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Local and Sepolia-only coursework token. It has no monetary value.
contract YDToken is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 1_000 ether;
    uint256 public constant FAUCET_COOLDOWN = 1 days;
    uint256 public constant AGENT_AIRDROP_AMOUNT = 500 ether;
    uint256 public constant PUBLISHER_AIRDROP_AMOUNT = 500 ether;

    mapping(address account => uint256 timestamp) public nextClaimAt;
    mapping(address account => bool claimed) public agentAirdropClaimed;
    mapping(address account => bool claimed) public publisherAirdropClaimed;
    address public airdropDistributor;

    error FaucetCoolingDown(uint256 availableAt);
    error AirdropAlreadyClaimed(address account, uint8 kind);
    error NotAirdropDistributor(address caller);
    error InvalidAccount();

    event AirdropDistributorUpdated(address indexed distributor);
    event AirdropGranted(address indexed account, uint8 indexed kind, bytes32 indexed referenceId, uint256 amount);

    constructor() ERC20("YD Test Token", "YD") Ownable(msg.sender) {
        airdropDistributor = msg.sender;
    }

    function faucet() external {
        uint256 availableAt = nextClaimAt[msg.sender];
        if (block.timestamp < availableAt) {
            revert FaucetCoolingDown(availableAt);
        }

        nextClaimAt[msg.sender] = block.timestamp + FAUCET_COOLDOWN;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function setAirdropDistributor(address distributor) external onlyOwner {
        if (distributor == address(0)) revert InvalidAccount();
        airdropDistributor = distributor;
        emit AirdropDistributorUpdated(distributor);
    }

    function grantAgentAirdrop(address account, bytes32 agentRef) external {
        _requireDistributor();
        if (account == address(0)) revert InvalidAccount();
        if (agentAirdropClaimed[account]) revert AirdropAlreadyClaimed(account, 1);
        agentAirdropClaimed[account] = true;
        _mint(account, AGENT_AIRDROP_AMOUNT);
        emit AirdropGranted(account, 1, agentRef, AGENT_AIRDROP_AMOUNT);
    }

    function grantPublisherAirdrop(address account, bytes32 taskRef) external {
        _requireDistributor();
        if (account == address(0)) revert InvalidAccount();
        if (publisherAirdropClaimed[account]) revert AirdropAlreadyClaimed(account, 2);
        publisherAirdropClaimed[account] = true;
        _mint(account, PUBLISHER_AIRDROP_AMOUNT);
        emit AirdropGranted(account, 2, taskRef, PUBLISHER_AIRDROP_AMOUNT);
    }

    function _requireDistributor() private view {
        if (msg.sender != airdropDistributor) revert NotAirdropDistributor(msg.sender);
    }
}
