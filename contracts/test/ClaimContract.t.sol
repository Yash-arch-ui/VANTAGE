// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ClaimContract.sol";

contract ClaimContractTest is Test {
    ClaimContract public claimContract;
    address public owner;
    address public claimer;
    address public otherClaimer;

    function setUp() public {
        owner = makeAddr("owner");
        claimer = makeAddr("claimer");
        otherClaimer = makeAddr("otherClaimer");

        claimContract = new ClaimContract();
    }

    function test_claim_succeedsForFreshSlot() public {
        vm.prank(claimer);
        claimContract.claim(0);

        assertEq(claimContract.claims(0), claimer);
        assertEq(claimContract.claimedCount(), 1);
        assertEq(claimContract.isClaimed(0), true);
        assertEq(claimContract.remainingSlots(), 9);
    }

    function test_claim_revertsWithSlotAlreadyClaimed_sameAddress() public {
        vm.prank(claimer);
        claimContract.claim(0);

        vm.expectRevert(abi.encodeWithSignature("SlotAlreadyClaimed(uint256)", 0));
        claimContract.claim(0);
    }

    function test_claim_revertsWithSlotAlreadyClaimed_differentAddress() public {
        vm.prank(claimer);
        claimContract.claim(0);

        vm.prank(otherClaimer);
        vm.expectRevert(abi.encodeWithSignature("SlotAlreadyClaimed(uint256)", 0));
        claimContract.claim(0);
    }

    function test_claim_revertsWithInvalidSlot_outOfRange() public {
        vm.expectRevert(abi.encodeWithSignature("InvalidSlot()"));
        claimContract.claim(10);
    }

    function test_claim_revertsWithInvalidSlot_maxSlot() public {
        vm.expectRevert(abi.encodeWithSignature("InvalidSlot()"));
        claimContract.claim(10);
    }

    function test_totalClaimed_and_remainingSlots_updateCorrectly() public {
        vm.prank(claimer);
        claimContract.claim(0);
        assertEq(claimContract.totalClaimed(), 1);
        assertEq(claimContract.remainingSlots(), 9);

        vm.prank(otherClaimer);
        claimContract.claim(1);
        assertEq(claimContract.totalClaimed(), 2);
        assertEq(claimContract.remainingSlots(), 8);
    }

    function test_isClaimed_returnsFalseForUnclaimedSlot() public {
        assertEq(claimContract.isClaimed(0), false);
        assertEq(claimContract.isClaimed(5), false);
    }

    function test_isClaimed_returnsTrueAfterClaim() public {
        vm.prank(claimer);
        claimContract.claim(5);
        assertEq(claimContract.isClaimed(5), true);
    }

    function test_allSlotsCanBeClaimed() public {
        address[] memory claimers = new address[](10);
        claimers[0] = claimer;
        claimers[1] = otherClaimer;
        claimers[2] = makeAddr("c2");
        claimers[3] = makeAddr("c3");
        claimers[4] = makeAddr("c4");
        claimers[5] = makeAddr("c5");
        claimers[6] = makeAddr("c6");
        claimers[7] = makeAddr("c7");
        claimers[8] = makeAddr("c8");
        claimers[9] = makeAddr("c9");

        for (uint256 i = 0; i < 10; i++) {
            vm.prank(claimers[i]);
            claimContract.claim(i);
        }

        assertEq(claimContract.totalClaimed(), 10);
        assertEq(claimContract.remainingSlots(), 0);
    }

    function test_claim_afterAllSlotsFilled_revertsForAnySlot() public {
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(claimer);
            claimContract.claim(i);
        }

        vm.expectRevert(abi.encodeWithSignature("InvalidSlot()"));
        claimContract.claim(11);
    }
}