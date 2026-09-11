// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterPairLaunchpad} from "../src/UnderwaterPairLaunchpad.sol";
import {MockEquity} from "./MockEquity.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

interface IRouterProbe {
    function factory() external view returns (address);
    function WETH() external view returns (address);
}

/// @notice Deploys the equity-pair launchpad plus, on a testnet, the mock
///         equities to pair against and their curated economics.
///
/// The real Robinhood equities exist only on mainnet 4663, so testnet runs on
/// mock 18-decimal ERC20s priced through the owner override
/// (`setPairTokenEconomics`) rather than the route pricer — see the plan.
///
/// Dry run (no broadcast) against Robinhood testnet:
///   DEX_ROUTER=0x0a74c808A0f849695b9CfBBC6800C46de1D3e4c5 \
///     forge script script/DeployPairLaunchpad.s.sol --rpc-url robinhood_testnet
///
/// Broadcast:
///   DEX_ROUTER=0x0a74c808A0f849695b9CfBBC6800C46de1D3e4c5 \
///     forge script script/DeployPairLaunchpad.s.sol --rpc-url robinhood_testnet \
///     --broadcast
///
/// Set DEPLOY_MOCKS=false on mainnet, where the launchpad is pointed at the real
/// equity addresses and economics come from the route pricer instead.
contract DeployPairLaunchpad is Script {
    /// @dev Testnet faucet balance minted to the deployer for each mock, so it
    ///      can seed test wallets and fund its own buys.
    uint256 internal constant MOCK_INITIAL_SUPPLY = 1_000_000e18;

    function run() external returns (UnderwaterPairLaunchpad pad) {
        address router = vm.envOr("DEX_ROUTER", address(0));
        uint256 tradeFeeBps = vm.envOr("TRADE_FEE_BPS", uint256(100)); // 1%
        uint256 creationFee = vm.envOr("CREATION_FEE", uint256(0)); // free on testnet
        uint256 graduationFeeBps = vm.envOr("GRADUATION_FEE_BPS", uint256(500)); // 5%

        // Three-way split of the trade fee: protocol 30 / buyback&burn 20 /
        // creator 50. Must sum to 10000; owner-settable after deploy.
        uint256 protocolShareBps = vm.envOr("PROTOCOL_SHARE_BPS", uint256(3_000));
        uint256 burnShareBps = vm.envOr("BURN_SHARE_BPS", uint256(2_000));
        uint256 creatorShareBps = vm.envOr("CREATOR_SHARE_BPS", uint256(5_000));

        bool deployMocks = vm.envOr("DEPLOY_MOCKS", true);

        address deployer = msg.sender;
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address owner = vm.envOr("OWNER", deployer);

        _assertRouterIsSane(router);

        console2.log("chain id        ", block.chainid);
        console2.log("deployer        ", deployer);
        console2.log("owner           ", owner);
        console2.log("fee recipient   ", feeRecipient);
        console2.log("router          ", router);
        console2.log("trade fee bps   ", tradeFeeBps);
        console2.log("creation fee    ", creationFee);
        console2.log("grad fee bps    ", graduationFeeBps);
        console2.log("split p/b/c     ", protocolShareBps, burnShareBps, creatorShareBps);

        vm.startBroadcast();

        pad = new UnderwaterPairLaunchpad(
            owner,
            router,
            feeRecipient,
            tradeFeeBps,
            creationFee,
            graduationFeeBps,
            protocolShareBps,
            burnShareBps,
            creatorShareBps
        );

        if (deployMocks) {
            // graduationQuote is the quote-token count worth ~4 ETH (~$7,700) at
            // the pons price snapshot: TSLA ~$311, NVDA ~$194, SPY ~$742. These
            // are curated testnet economics; owner-settable, and on mainnet the
            // route pricer supplies them instead.
            _deployMock(pad, owner, deployer, "Mock Tesla", "mTSLA", 25e18);
            _deployMock(pad, owner, deployer, "Mock NVIDIA", "mNVDA", 40e18);
            _deployMock(pad, owner, deployer, "Mock S&P 500", "mSPY", 10e18);
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("UnderwaterPairLaunchpad deployed at", address(pad));
        console2.log("curve supply                       ", pad.CURVE_SUPPLY());
        console2.log("lp supply                          ", pad.LP_SUPPLY());
    }

    function _deployMock(
        UnderwaterPairLaunchpad pad,
        address owner,
        address deployer,
        string memory name,
        string memory symbol,
        uint256 graduationQuote
    ) internal {
        MockEquity mock = new MockEquity(name, symbol, deployer, MOCK_INITIAL_SUPPLY);
        // The launchpad owner sets the economics. Broadcasting from the deployer
        // only works while it is still the owner; if OWNER is a different
        // address, run setPairTokenEconomics from there afterwards.
        if (owner == deployer) {
            pad.setPairTokenEconomics(address(mock), graduationQuote);
        }
        console2.log(symbol, address(mock), graduationQuote);
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
