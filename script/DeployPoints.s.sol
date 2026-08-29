// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterPoints} from "../src/UnderwaterPoints.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Deploys the uwPoint rate card and coupon book.
///
/// Nothing about this deploy is urgent and nothing about it is final. The rates
/// are settable, the owner is transferable in two steps, and balances are counted
/// off chain from logs the other contracts have been emitting since they went up —
/// so deploying this late credits everything that already happened rather than
/// starting a clock. That is the whole reason the rate card is a contract and the
/// balances are not: there is no state to migrate and no backfill to get wrong.
///
/// The rates below are the launch numbers. Override any of them from the
/// environment for a testnet where you want to watch a balance move without
/// sending a hundred transactions.
///
/// Dry run (no broadcast):
///   forge script script/DeployPoints.s.sol --rpc-url ink_sepolia
///
/// Broadcast:
///   forge script script/DeployPoints.s.sol --rpc-url ink_sepolia --broadcast --verify \
///     --verifier blockscout --verifier-url https://explorer-sepolia.inkonchain.com/api
contract DeployPoints is Script {
    function run() external returns (UnderwaterPoints points) {
        // Whoever broadcasts owns it. Named explicitly rather than left implicit,
        // because the owner is the only address that can move a rate or issue a
        // coupon and it is worth reading back off the console before signing.
        address owner = vm.envOr("POINTS_OWNER", msg.sender);

        UnderwaterPoints.Rates memory rates = UnderwaterPoints.Rates({
            register: uint64(vm.envOr("POINTS_REGISTER", uint256(10_000))),
            referral: uint64(vm.envOr("POINTS_REFERRAL", uint256(1_000))),
            create: uint64(vm.envOr("POINTS_CREATE", uint256(20_000))),
            swap: uint64(vm.envOr("POINTS_SWAP", uint256(10)))
        });

        console2.log("chain id     ", block.chainid);
        console2.log("deployer     ", msg.sender);
        console2.log("owner        ", owner);
        console2.log("");
        console2.log("uwPoints per registration ", rates.register);
        console2.log("uwPoints per referral     ", rates.referral);
        console2.log("uwPoints per token launch ", rates.create);
        console2.log("uwPoints per trade        ", rates.swap);

        vm.startBroadcast();
        points = new UnderwaterPoints(owner, rates);
        vm.stopBroadcast();

        console2.log("");
        console2.log("UnderwaterPoints deployed at", address(points));
        console2.log("");
        console2.log("Every rate above is settable by the owner with setRates. Next:");
        console2.log("  1. NEXT_PUBLIC_POINTS_<chain>=<address> in web/.env.local, then rebuild");
        console2.log("  2. the owner-only Points tab on /profile sets rates and issues coupons");
        console2.log("");
        console2.log("There are no balances in this contract, by design. A balance is");
        console2.log("rates x on-chain log counts + granted[who], counted by the reader.");
    }
}
