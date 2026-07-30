// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

error SlotAlreadyClaimed(uint256 slotId);
error InvalidSlot();

contract MockClaim {
    mapping(uint256 => address) public claims;
    uint256 public claimedCount;
    uint256 public constant TOTAL_SLOTS = 10;

    event Claimed(uint256 indexed slotId, address indexed caller);

    function claim(uint256 slotId) external {
        if (slotId >= TOTAL_SLOTS) {
            revert InvalidSlot();
        }

        if (claims[slotId] != address(0)) {
            revert SlotAlreadyClaimed(slotId);
        }

        claims[slotId] = msg.sender;
        claimedCount += 1;

        emit Claimed(slotId, msg.sender);
    }

    function isClaimed(uint256 slotId) external view returns (bool) {
        return claims[slotId] != address(0);
    }

    function totalClaimed() external view returns (uint256) {
        return claimedCount;
    }

    function remainingSlots() external view returns (uint256) {
        return TOTAL_SLOTS - claimedCount;
    }
}