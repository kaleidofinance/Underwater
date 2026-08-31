// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterFactory} from "../src/dex/UnderwaterFactory.sol";
import {UnderwaterRouter} from "../src/dex/UnderwaterRouter.sol";
import {Weth} from "./Weth.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Deploys the Underwater DEX (factory + router).
///
/// The protocol fee is deliberately left OFF. Switch it on later with
/// `UnderwaterFactory.setFeeTo(treasury)` once the owner is a multisig, so the
/// first pools open with 100% of the 0.3% going to LPs.
///
/// Dry run (no broadcast):
///   forge script script/DeployDex.s.sol --rpc-url ink_sepolia
///
/// Broadcast:
///   forge script script/DeployDex.s.sol --rpc-url ink --broadcast --verify \
///     --verifier blockscout --verifier-url https://explorer.inkonchain.com/api
///
/// On Robinhood Chain Testnet, where the explorer is a Blockscout of its own:
///   forge script script/DeployDex.s.sol --rpc-url robinhood_testnet --broadcast --verify \
///     --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api
contract DeployDex is Script {
    function run() external returns (UnderwaterFactory factory, UnderwaterRouter router) {
        address deployer = msg.sender;
        address owner = vm.envOr("OWNER", deployer);

        // Two steps rather than `vm.envOr("WETH", Weth.forChain(block.chainid))`,
        // because the default argument is evaluated eagerly: an unknown chain would
        // revert inside the table even when `WETH` is set, which is exactly the case
        // the override exists for (a local run against a freshly deployed WETH9).
        address weth = vm.envOr("WETH", address(0));
        if (weth == address(0)) weth = Weth.forChain(block.chainid);

        require(weth.code.length > 0, "WETH has no code on this chain");

        console2.log("chain id ", block.chainid);
        console2.log("deployer ", deployer);
        console2.log("owner    ", owner);
        console2.log("WETH     ", weth);

        vm.startBroadcast();
        factory = new UnderwaterFactory(owner);
        router = new UnderwaterRouter(address(factory), weth);
        vm.stopBroadcast();

        // A router pointed at the wrong factory would create pools nobody can
        // find, so confirm the wiring before printing it as done.
        require(router.factory() == address(factory), "router/factory mismatch");
        require(router.WETH() == weth, "router/WETH mismatch");

        console2.log("");
        console2.log("UnderwaterFactory  ", address(factory));
        console2.log("UnderwaterRouter   ", address(router));
        console2.log("pair init code hash");
        console2.logBytes32(factory.pairInitCodeHash());
        console2.log("");
        console2.log("Next: set DEX_ROUTER to the router above, then run script/Deploy.s.sol.");
        console2.log("Protocol fee is OFF. Enable later with setFeeTo(<treasury>).");
    }
}
