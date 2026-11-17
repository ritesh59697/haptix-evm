// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {PasskeyAccount} from "../src/PasskeyAccount.sol";
import {PasskeyAccountFactory} from "../src/PasskeyAccountFactory.sol";

/// @title DeployMainnet
/// @notice Deploys the Haptix PasskeyAccount implementation and PasskeyAccountFactory
///         to any EVM chain. Every chain-specific value comes from the environment,
///         so adding a chain means adding a file under `networks/`, not editing code.
///
/// @dev Required env:
///        CHAIN_ID            chain the operator intends to hit; the script refuses any other
///        ENTRYPOINT_ADDRESS  ERC-4337 v0.7 EntryPoint on that chain
///      Optional env:
///        EXPLORER_URL        e.g. https://explorer.example/ (used only for log links)
///
///      Usage (Robinhood Chain testnet):
///        set -a; source networks/robinhood-testnet.env; set +a
///        node scripts/chain-preflight.mjs
///        forge script script/DeployMainnet.s.sol:DeployMainnet \
///          --rpc-url "$RPC_URL" --account <keystore-name> --broadcast
contract DeployMainnet is Script {
    function run() external returns (PasskeyAccount implementation, PasskeyAccountFactory factory) {
        uint256 expectedChainId = vm.envUint("CHAIN_ID");
        address entryPoint = vm.envAddress("ENTRYPOINT_ADDRESS");
        string memory explorer = vm.envOr("EXPLORER_URL", string(""));

        require(block.chainid == expectedChainId, "RPC chain id does not match CHAIN_ID");
        require(entryPoint.code.length > 0, "no EntryPoint code at ENTRYPOINT_ADDRESS on this chain");

        console.log("==================================================");
        console.log("Haptix factory deployment");
        console.log("Chain ID:   ", block.chainid);
        console.log("EntryPoint: ", entryPoint);
        console.log("==================================================");

        // The implementation is locked (_initialized = true) in its constructor and
        // needs >= 2 signers to construct. Placeholder keys + max threshold: it can
        // never validate a signature and never holds funds.
        PasskeyAccount.PublicKey[] memory placeholder = new PasskeyAccount.PublicKey[](2);
        placeholder[0] = PasskeyAccount.PublicKey(1, 2);
        placeholder[1] = PasskeyAccount.PublicKey(3, 4);

        vm.startBroadcast();
        implementation = new PasskeyAccount(entryPoint, placeholder, type(uint256).max);
        factory = new PasskeyAccountFactory(address(implementation));
        vm.stopBroadcast();

        require(factory.entryPoint() == entryPoint, "factory EntryPoint mismatch");

        console.log("");
        console.log("Implementation:", address(implementation));
        console.log("Factory:       ", address(factory));
        if (bytes(explorer).length > 0) {
            console.log("Implementation explorer:", string.concat(explorer, "address/", vm.toString(address(implementation))));
            console.log("Factory explorer:       ", string.concat(explorer, "address/", vm.toString(address(factory))));
        }
        console.log("");
        console.log("Next: set FACTORY_ADDRESS in your network file, then run scripts/chain-e2e.mjs");
    }
}
