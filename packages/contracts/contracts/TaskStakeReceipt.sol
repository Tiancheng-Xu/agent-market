// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract TaskStakeReceipt is ERC721, Ownable {
    address public escrow;

    error EscrowAlreadyConfigured();
    error UnauthorizedEscrow(address caller);
    error InvalidEscrow();

    constructor() ERC721("Agent Market Task Stake", "AMTS") Ownable(msg.sender) {}

    function configureEscrow(address escrowAddress) external onlyOwner {
        if (escrow != address(0)) revert EscrowAlreadyConfigured();
        if (escrowAddress == address(0)) revert InvalidEscrow();
        escrow = escrowAddress;
    }

    function mint(address participant, uint256 receiptId) external {
        if (msg.sender != escrow) revert UnauthorizedEscrow(msg.sender);
        _safeMint(participant, receiptId);
    }

    function burn(uint256 receiptId) external {
        if (msg.sender != escrow) revert UnauthorizedEscrow(msg.sender);
        _burn(receiptId);
    }
}
