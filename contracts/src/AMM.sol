// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";

error InsufficientOutputAmount(uint256 expected, uint256 actual);
error InvalidLiquidityAmounts();
error Unauthorized();
error ReentrancyDetected();

contract AMM {
    address public token;
    uint256 public tokenReserve;
    uint256 public monReserve;
    address public owner;

    bool private locked;

    event LiquidityAdded(address indexed provider, uint256 tokenAmount, uint256 monAmount);
    event Swap(
        address indexed trader,
        bool inputIsToken,
        uint256 inputAmount,
        uint256 outputAmount
    );

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert Unauthorized();
        }
        _;
    }

    modifier nonReentrant() {
        if (locked) {
            revert ReentrancyDetected();
        }
        locked = true;
        _;
        locked = false;
    }

    constructor(address _token) {
        token = _token;
        owner = msg.sender;
    }

    function addLiquidity(uint256 tokenAmount) external payable nonReentrant {
        if (tokenAmount == 0 && msg.value == 0) {
            revert InvalidLiquidityAmounts();
        }

        // If this is the first liquidity add, both sides must be nonzero
        if (tokenReserve == 0 && monReserve == 0) {
            if (tokenAmount == 0 || msg.value == 0) {
                revert InvalidLiquidityAmounts();
            }
        }

        // Checks: pull tokens via transferFrom
        MockERC20(token).transferFrom(msg.sender, address(this), tokenAmount);

        // Effects: update reserves before any external calls
        tokenReserve += tokenAmount;
        monReserve += msg.value;

        // Interactions: emit event after state updates
        emit LiquidityAdded(msg.sender, tokenAmount, msg.value);
    }

    function getExpectedOutput(
        uint256 inputAmount,
        bool inputIsToken
    ) public view returns (uint256) {
        uint256 inputReserve = inputIsToken ? tokenReserve : monReserve;
        uint256 outputReserve = inputIsToken ? monReserve : tokenReserve;

        if (inputReserve == 0) {
            return 0;
        }

        return (inputAmount * outputReserve) / (inputReserve + inputAmount);
    }

    function swap(
        uint256 minOutput,
        bool inputIsToken,
        uint256 inputAmount
    ) external payable nonReentrant {
        uint256 actualInput;

        if (inputIsToken) {
            // Input is token: msg.value must be zero, inputAmount is the token qty
            if (msg.value != 0) {
                revert InvalidLiquidityAmounts();
            }
            actualInput = inputAmount;

            // Pull tokens from caller via transferFrom
            MockERC20(token).transferFrom(msg.sender, address(this), actualInput);
        } else {
            // Input is MON: the input amount is msg.value
            actualInput = msg.value;
        }

        uint256 output = getExpectedOutput(actualInput, inputIsToken);

        if (output < minOutput) {
            revert InsufficientOutputAmount(minOutput, output);
        }

        // Effects: update reserves first (checks-effects-interactions)
        if (inputIsToken) {
            tokenReserve += actualInput;
            monReserve -= output;
        } else {
            monReserve += actualInput;
            tokenReserve -= output;
        }

        // Interactions: transfer output to msg.sender last.
        // Uses call{value} instead of transfer() so smart-contract wallets (Safe, smart
        // accounts) that need more than the 2300 gas stipend transfer() provides can receive
        // funds. nonReentrant already handles the reentrancy risk this deeper gas forward introduces.
        if (inputIsToken) {
            (bool sent, bytes memory returndata) = payable(msg.sender).call{value: output}("");
            if (!sent) {
                assembly {
                    revert(add(32, returndata), mload(returndata))
                }
            }
        } else {
            // Output is token — transfer via MockERC20
            MockERC20(token).transfer(msg.sender, output);
        }

        emit Swap(msg.sender, inputIsToken, actualInput, output);
    }

    // DEMO-ONLY: This function intentionally shifts pool reserves without
    // any corresponding token or MON movement. It simulates state-drift
    // between quote and sign as if another trader had moved the pool.
    // This would NEVER exist in production — it breaks physical consistency.
    function manipulateReserves(
        uint256 newTokenReserve,
        uint256 newMonReserve
    ) external onlyOwner {
        tokenReserve = newTokenReserve;
        monReserve = newMonReserve;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (tokenReserve, monReserve);
    }

    // Expose ETH receive for MON deposits without explicit swap calls
    receive() external payable {}
}