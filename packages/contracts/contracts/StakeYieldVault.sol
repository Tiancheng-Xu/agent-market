// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract StakeYieldVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant YEAR = 365 days;
    uint256 public constant RATE_PERCENT = 6;

    struct Position {
        uint256 principal;
        uint256 accrued;
        uint64 checkpointAt;
    }

    IERC20 public immutable yd;
    uint256 public rewardReserve;
    mapping(address account => Position position) public positions;

    error InvalidAmount();
    error InsufficientPrincipal(uint256 available);
    error InsufficientRewardReserve(uint256 available, uint256 required);

    event RewardPoolFunded(address indexed funder, uint256 amount);
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event YieldClaimed(address indexed account, uint256 amount);

    constructor(IERC20 token) Ownable(msg.sender) {
        yd = token;
    }

    function fundRewardPool(uint256 amount) external onlyOwner {
        if (amount == 0) revert InvalidAmount();
        rewardReserve += amount;
        yd.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardPoolFunded(msg.sender, amount);
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        Position storage position = positions[msg.sender];
        _checkpoint(position);
        position.principal += amount;
        yd.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        Position storage position = positions[msg.sender];
        if (amount == 0 || amount > position.principal) revert InsufficientPrincipal(position.principal);
        _checkpoint(position);
        position.principal -= amount;
        yd.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claimYield() external nonReentrant returns (uint256 amount) {
        Position storage position = positions[msg.sender];
        _checkpoint(position);
        amount = position.accrued;
        if (amount > rewardReserve) revert InsufficientRewardReserve(rewardReserve, amount);
        position.accrued = 0;
        rewardReserve -= amount;
        yd.safeTransfer(msg.sender, amount);
        emit YieldClaimed(msg.sender, amount);
    }

    function earned(address account) public view returns (uint256) {
        Position memory position = positions[account];
        if (position.principal == 0 || position.checkpointAt == 0) return position.accrued;
        uint256 elapsed = block.timestamp - position.checkpointAt;
        return position.accrued + _linearYield(position.principal, elapsed);
    }

    function _checkpoint(Position storage position) private {
        if (position.checkpointAt != 0 && position.principal != 0) {
            position.accrued += _linearYield(position.principal, block.timestamp - position.checkpointAt);
        }
        position.checkpointAt = uint64(block.timestamp);
    }

    function _linearYield(uint256 principal, uint256 elapsed) private pure returns (uint256) {
        return principal * RATE_PERCENT * elapsed / (100 * YEAR);
    }
}
