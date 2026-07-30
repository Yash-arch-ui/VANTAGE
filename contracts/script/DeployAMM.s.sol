// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "../lib/forge-std/src/Script.sol";
import {MockAMM} from "../src/MockAMM.sol";

contract DeployAMMScript is Script {
    function run() external returns (MockAMM amm) {
        uint256 deployerPrivateKey = vm.envOr(
            "PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );
        
        // Pass token address via environment variable or update directly here
        address tokenAddress = vm.envAddress("TOKEN_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        amm = new MockAMM(tokenAddress);
        console.log("MockAMM deployed at:", address(amm));

        vm.stopBroadcast();
    }
}