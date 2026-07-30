// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "../lib/forge-std/src/Script.sol";
import {MockClaim} from "../src/MockClaim.sol";

contract DeployClaimScript is Script {
    function run() external returns (MockClaim claim) {
        uint256 deployerPrivateKey = vm.envOr(
            "PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );

        vm.startBroadcast(deployerPrivateKey);

        claim = new MockClaim();
        console.log("MockClaim deployed at:", address(claim));

        vm.stopBroadcast();
    }
}