// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "../lib/forge-std/src/Test.sol";
import "../src/MockERC20.sol";
import "../src/AMM.sol";

contract AMMTest is Test {
    MockERC20 public token;
    AMM public amm;
    address public owner;
    address public trader;
    address public otherTrader;

    uint256 constant INITIAL_TOKEN = 1000e18;
    uint256 constant INITIAL_MON = 10 ether;

    function setUp() public {
        owner = makeAddr("owner");
        trader = makeAddr("trader");
        otherTrader = makeAddr("otherTrader");

        vm.deal(owner, 100 ether);
        vm.deal(trader, 100 ether);
        vm.deal(otherTrader, 100 ether);

        vm.startPrank(owner);
        token = new MockERC20("Demo Token", "DEMO", 18);
        amm = new AMM(address(token));
        vm.stopPrank();

        vm.startPrank(owner);
        token.mint(owner, INITIAL_TOKEN);
        token.mint(trader, INITIAL_TOKEN);
        token.mint(otherTrader, INITIAL_TOKEN);
        vm.stopPrank();
    }

    function test_addLiquidity_setsReservesCorrectly() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        amm.addLiquidity{value: INITIAL_MON}(INITIAL_TOKEN);
        vm.stopPrank();

        assertEq(amm.tokenReserve(), INITIAL_TOKEN);
        assertEq(amm.monReserve(), INITIAL_MON);
        assertEq(amm.owner(), owner);
    }

    function test_addLiquidity_failsWithZeroTokenAndZeroMon() public {
        vm.expectRevert(abi.encodeWithSignature("InvalidLiquidityAmounts()"));
        amm.addLiquidity{value: 0}(0);
    }

    function test_addLiquidity_firstLiquidityRejectsZeroTokenSide() public {
        vm.expectRevert(abi.encodeWithSignature("InvalidLiquidityAmounts()"));
        amm.addLiquidity{value: INITIAL_MON}(0);
    }

    function test_addLiquidity_firstLiquidityRejectsZeroMonSide() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSignature("InvalidLiquidityAmounts()"));
        amm.addLiquidity{value: 0}(INITIAL_TOKEN);
    }

    function test_getExpectedOutput_matchesConstantProduct() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        amm.addLiquidity{value: INITIAL_MON}(INITIAL_TOKEN);
        vm.stopPrank();

        uint256 expectedOutput = (1e18 * INITIAL_MON) / (INITIAL_TOKEN + 1e18);
        uint256 actualOutput = amm.getExpectedOutput(1e18, true);

        assertEq(actualOutput, expectedOutput);
    }

    function test_getExpectedOutput_forMonInput() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        amm.addLiquidity{value: INITIAL_MON}(INITIAL_TOKEN);
        vm.stopPrank();

        uint256 monInput = 1 ether;
        uint256 expectedOutput = (monInput * INITIAL_TOKEN) / (INITIAL_MON + monInput);
        uint256 actualOutput = amm.getExpectedOutput(monInput, false);

        assertEq(actualOutput, expectedOutput);
    }

    function test_swap_succeedsWhenOutputMeetsMinimum() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        amm.addLiquidity{value: INITIAL_MON}(INITIAL_TOKEN);
        vm.stopPrank();

        vm.startPrank(trader);
        token.approve(address(amm), 1e18);

        uint256 minOutput = amm.getExpectedOutput(1e18, true) / 2;
        amm.swap(minOutput, true, 1e18);
        vm.stopPrank();
    }

    function test_swap_revertsWithInsufficientOutputAmount() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        amm.addLiquidity{value: INITIAL_MON}(INITIAL_TOKEN);
        vm.stopPrank();

        vm.startPrank(trader);
        token.approve(address(amm), 1e18);

        uint256 actualOutput = amm.getExpectedOutput(1e18, true);
        uint256 minOutput = actualOutput + 1;

        vm.expectRevert(abi.encodeWithSignature("InsufficientOutputAmount(uint256,uint256)", minOutput, actualOutput));
        amm.swap(minOutput, true, 1e18);
        vm.stopPrank();
    }

    function test_manipulateReserves_isOnlyOwner() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        amm.addLiquidity{value: INITIAL_MON}(INITIAL_TOKEN);
        vm.stopPrank();

        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSignature("Unauthorized()"));
        amm.manipulateReserves(2000e18, 5 ether);
        vm.stopPrank();
    }

    function test_manipulateReserves_changesGetExpectedOutput() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        amm.addLiquidity{value: INITIAL_MON}(INITIAL_TOKEN);
        vm.stopPrank();

        uint256 outputBefore = amm.getExpectedOutput(1e18, true);

        vm.startPrank(owner);
        amm.manipulateReserves(2000e18, 5 ether);
        vm.stopPrank();

        uint256 outputAfter = amm.getExpectedOutput(1e18, true);

        assert(outputBefore != outputAfter);
    }

    function test_reentrancyGuard_blocksReentrantSwap() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        amm.addLiquidity{value: INITIAL_MON}(INITIAL_TOKEN);
        vm.stopPrank();

        ReentrancyAttacker attacker = new ReentrancyAttacker(amm);

        vm.deal(address(attacker), 1 ether);

        vm.startPrank(address(attacker));
        token.mint(address(attacker), 1e18);
        token.approve(address(amm), 1e18);

        // reentrancyAttack triggers a swap (token→MON). When the AMM sends
        // MON back via call{value}(""), the attacker's receive() fires and
        // attempts a nested swap. The nonReentrant guard must block this
        // re-entrant call, reverting with ReentrancyDetected.
        vm.expectRevert(abi.encodeWithSignature("ReentrancyDetected()"));
        attacker.reentrancyAttack(1e18, true, 0);
        vm.stopPrank();
    }

    function test_swap_monInput_succeeds() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        amm.addLiquidity{value: INITIAL_MON}(INITIAL_TOKEN);
        vm.stopPrank();

        vm.startPrank(trader);

        uint256 monInput = 1 ether;
        uint256 minOutput = amm.getExpectedOutput(monInput, false) / 2;

        amm.swap{value: monInput}(minOutput, false, monInput);
        vm.stopPrank();
    }

    function test_getReserves_returnsCurrentReserves() public {
        vm.startPrank(owner);
        token.approve(address(amm), INITIAL_TOKEN);
        amm.addLiquidity{value: INITIAL_MON}(INITIAL_TOKEN);
        vm.stopPrank();

        (uint256 tokenRes, uint256 monRes) = amm.getReserves();
        assertEq(tokenRes, INITIAL_TOKEN);
        assertEq(monRes, INITIAL_MON);
    }
}

contract ReentrancyAttacker {
    AMM public amm;
    bool public attemptedReentry;

    constructor(AMM _amm) {
        amm = _amm;
    }

    receive() external payable {
        attemptedReentry = true;

        // Attempt to re-enter swap while the nonReentrant guard is locked.
        // This MUST revert with ReentrancyDetected().
        (bool innerSuccess, bytes memory innerData) = address(amm).call(
            abi.encodeWithSignature("swap(uint256,bool,uint256)", 0, true, 0)
        );

        require(!innerSuccess, "Expected inner reentrant swap to revert");

        // Verify and propagate the ReentrancyDetected revert reason so
        // the outer call{value}("") propagates it all the way up.
        require(innerData.length >= 4, "Expected error data");
        bytes4 selector;
        assembly {
            selector := mload(add(innerData, 0x20))
        }
        require(
            selector == bytes4(keccak256("ReentrancyDetected()")),
            "Expected ReentrancyDetected"
        );

        assembly {
            revert(add(32, innerData), mload(innerData))
        }
    }

    function reentrancyAttack(
        uint256 inputAmount,
        bool inputIsToken,
        uint256 minOutput
    ) external payable {
        AMM(amm).swap(minOutput, inputIsToken, inputAmount);
    }

    fallback() external payable {}
}