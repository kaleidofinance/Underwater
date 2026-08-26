// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterLaunchpad} from "../src/UnderwaterLaunchpad.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

interface IRouterProbe {
    function factory() external view returns (address);
    function WETH() external view returns (address);
}

/// @notice Deploys the launchpad.
///
/// Dry run (no broadcast):
///   forge script script/Deploy.s.sol --rpc-url ink_sepolia
///
/// Broadcast:
///   forge script script/Deploy.s.sol --rpc-url ink --broadcast --verify \
///     --verifier blockscout --verifier-url https://explorer.inkonchain.com/api
contract Deploy is Script {
    function run() external returns (UnderwaterLaunchpad pad) {
        // envOr, not envAddress: an unset or blank DEX_ROUTER should hit the
        // "not set" guard in _assertRouterIsSane rather than a hex parse error.
        address router = vm.envOr("DEX_ROUTER", address(0));
        uint256 tradeFeeBps = vm.envOr("TRADE_FEE_BPS", uint256(100));
        // Default ~$1.50 in ETH at ~$2,456/ETH (set 2026-08-26). A fixed wei
        // amount, not a USD peg, so its dollar value drifts with price; override
        // per deploy with CREATION_FEE (still capped at MAX_CREATION_FEE = 0.01 ether).
        uint256 creationFee = vm.envOr("CREATION_FEE", uint256(610816335672081));
        uint256 graduationFeeBps = vm.envOr("GRADUATION_FEE_BPS", uint256(500));

        address deployer = msg.sender;
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address owner = vm.envOr("OWNER", deployer);

        // Refuse to deploy against something that is not a working V2 router.
        // A wrong router address here means every graduation silently parks
        // instead of seeding liquidity, so this is worth failing loudly on.
        _assertRouterIsSane(router);

        console2.log("chain id        ", block.chainid);
        console2.log("deployer        ", deployer);
        console2.log("owner           ", owner);
        console2.log("fee recipient   ", feeRecipient);
        console2.log("router          ", router);
        console2.log("trade fee bps   ", tradeFeeBps);
        console2.log("creation fee    ", creationFee);
        console2.log("grad fee bps    ", graduationFeeBps);

        vm.startBroadcast();
        pad = new UnderwaterLaunchpad(owner, router, feeRecipient, tradeFeeBps, creationFee, graduationFeeBps);
        vm.stopBroadcast();

        console2.log("");
        console2.log("UnderwaterLaunchpad deployed at", address(pad));
        console2.log("graduation threshold (wei)     ", pad.GRADUATION_ETH());
        console2.log("curve supply                   ", pad.CURVE_SUPPLY());
        console2.log("lp supply                      ", pad.LP_SUPPLY());
    }

    function _assertRouterIsSane(address router) internal view {
        require(router != address(0), "DEX_ROUTER not set");
        require(router.code.length > 0, "DEX_ROUTER is not a contract");

        address factory = IRouterProbe(router).factory();
        address weth = IRouterProbe(router).WETH();

        require(factory != address(0) && factory.code.length > 0, "router factory invalid");
        require(weth != address(0) && weth.code.length > 0, "router WETH invalid");
    }
}
