// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {DemoSwapRouter, DemoToken} from "./demo/DemoDex.sol";

/// @notice Deploys the testnet-only demo tokens and router. Prices and names come from env.
/// @dev Required env: CHAIN_ID, DEMO_USD_PRICE, DEMO_STOCK_PRICE. Refuses a chain whose
///      env file doesn't name itself a testnet (DEMO_DEX_ALLOWED=true).
contract DeployDemoDex is Script {
    function run() external {
        require(block.chainid == vm.envUint("CHAIN_ID"), "RPC chain id does not match CHAIN_ID");
        require(vm.envBool("DEMO_DEX_ALLOWED"), "demo DEX is testnet-only");
        vm.startBroadcast();
        DemoToken usd = new DemoToken("Haptix Demo Dollar", "dUSD", vm.envUint("DEMO_USD_PRICE"));
        DemoToken stock = new DemoToken("Haptix Demo Stock", "dSTK", vm.envUint("DEMO_STOCK_PRICE"));
        DemoSwapRouter router = new DemoSwapRouter();
        vm.stopBroadcast();
        console.log("DEMO_USD_TOKEN=", address(usd));
        console.log("DEMO_STOCK_TOKEN=", address(stock));
        console.log("DEMO_SWAP_ROUTER=", address(router));
    }
}
