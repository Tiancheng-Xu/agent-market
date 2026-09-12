// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Local test double: no proof verification, billing or public-chain capability.
contract VRFSelectionCoordinatorMock {
    struct Request { bytes32 keyHash; uint256 subId; uint16 requestConfirmations; uint32 callbackGasLimit; uint32 numWords; bytes extraArgs; }
    uint256 public nextId = 1;
    bytes public lastRequest;
    bool public fail;
    function setNextId(uint256 id) external { nextId = id; }
    function setFail(bool value) external { fail = value; }
    function requestRandomWords(Request calldata req) external returns (uint256) {
        require(!fail, "unavailable");
        lastRequest = abi.encode(req);
        return nextId++;
    }
    function fulfill(address consumer, uint256 id, uint256[] calldata words) external {
        (bool ok,) = consumer.call{gas: 150000}(abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", id, words));
        require(ok, "callback failed");
    }
}
