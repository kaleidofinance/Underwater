// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Weth} from "../../script/Weth.sol";
import {UnderwaterLaunchpad} from "../../src/UnderwaterLaunchpad.sol";
import {UnderwaterFactory} from "../../src/dex/UnderwaterFactory.sol";
import {UnderwaterPair} from "../../src/dex/UnderwaterPair.sol";
import {UnderwaterRouter} from "../../src/dex/UnderwaterRouter.sol";
import {MemeToken} from "../../src/token/MemeToken.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Deploys the Underwater DEX onto a fork of a real network and runs a full
///         launch through it, against that chain's actual WETH.
///
/// This is the test that a mock WETH cannot replace: it proves our router speaks to
/// the real `deposit()`/`withdraw()` implementation, and that the whole system stands
/// up on a chain with no pre-existing DEX to depend on.
///
/// Every network the protocol can be deployed to gets a subclass, because the WETH
/// they wrap through is not one contract. Ink is OP Stack and uses the predeploy;
/// Robinhood is Arbitrum Nitro and has no predeploy, so its WETH is an ordinary
/// deployment — and on Robinhood mainnet, a proxy in front of one. The address comes
/// from [Weth](../../script/Weth.sol), the same table the deploy script resolves
/// through, so a subclass cannot silently test a different WETH than a real deploy
/// would use.
///
/// Skipped automatically when the RPC is unreachable, so `forge test` stays green
/// offline. Run explicitly with:
///   forge test --match-contract OwnDex -vv
abstract contract OwnDexForkTest is Test {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address internal weth;

    UnderwaterLaunchpad internal pad;
    UnderwaterFactory internal factory;
    UnderwaterRouter internal router;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal whale = makeAddr("whale");
    address internal stranger = makeAddr("stranger");

    bool internal forked;

    function _rpc() internal view virtual returns (string memory);

    function _label() internal pure virtual returns (string memory);

    function _chainId() internal pure virtual returns (uint256);

    function setUp() public {
        // Resolved from the declared id, not from `block.chainid`, so the assertion in
        // the first test compares the pair rather than restating it.
        weth = Weth.forChain(_chainId());

        try vm.createSelectFork(_rpc()) {
            forked = true;
        } catch {
            emit log(string.concat(_label(), " RPC unreachable - skipping fork test"));
            return;
        }

        factory = new UnderwaterFactory(owner);
        router = new UnderwaterRouter(address(factory), weth);
        pad = new UnderwaterLaunchpad(owner, address(router), treasury, 100, 0, 500);

        vm.deal(whale, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function test_wethIsRealOnThisChain() public view {
        if (!forked) return;
        assertEq(block.chainid, _chainId(), "RPC is not the chain this subclass describes");
        assertGt(weth.code.length, 0, "no WETH at the address the table gives for this chain");
    }

    function test_fullLaunchThroughOurOwnDex() public {
        if (!forked) return;

        vm.prank(creator);
        address token = pad.create("Underwater Squid", "SQUID", "ipfs://squid", 0);

        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        (,,,,,, bool graduated,) = pad.pools(token);
        assertTrue(graduated, "graduated");

        UnderwaterPair pair = UnderwaterPair(factory.getPair(token, weth));
        assertTrue(address(pair) != address(0), "pool created in our factory");

        uint256 expectedEth = pad.GRADUATION_ETH() - (pad.GRADUATION_ETH() * 500 / 10_000);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 ethReserve, uint256 tokenReserve) =
            pair.token0() == weth ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        assertEq(ethReserve, expectedEth, "3.8 ETH wrapped through the chain's real WETH");
        assertEq(tokenReserve, pad.LP_SUPPLY(), "200M tokens");

        // LP burned, launchpad empty.
        assertGt(pair.balanceOf(DEAD), 0, "LP burned");
        assertEq(pair.balanceOf(address(pad)), 0);
        assertEq(address(pad).balance, 0, "nothing stranded");

        emit log_named_uint("chain id", block.chainid);
        emit log_named_address("pool", address(pair));
    }

    function test_strangerTradesOnOurDexAfterGraduation() public {
        if (!forked) return;

        vm.prank(creator);
        address token = pad.create("Underwater Squid", "SQUID", "ipfs://squid", 0);
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        // Buy with native ETH: the router wraps through the chain's real WETH.
        vm.prank(stranger);
        router.swapExactETHForTokens{value: 1 ether}(
            0, _path(weth, token), stranger, block.timestamp + 1 hours
        );
        uint256 bought = MemeToken(token).balanceOf(stranger);
        assertGt(bought, 0, "bought on our DEX");

        // Sell back out for native ETH: the router unwraps through the real WETH,
        // which is the leg a mock would never exercise.
        uint256 ethBefore = stranger.balance;
        vm.startPrank(stranger);
        MemeToken(token).approve(address(router), bought);
        router.swapExactTokensForETH(bought, 0, _path(token, weth), stranger, block.timestamp + 1 hours);
        vm.stopPrank();

        uint256 recovered = stranger.balance - ethBefore;
        assertGt(recovered, 0, "unwrapped back to native ETH");
        assertLt(recovered, 1 ether, "round trip costs fees plus impact");
    }
}

/// @notice Ink Sepolia has no third-party V2 DEX at all, so this is the only way
///         the full system runs on the testnet.
contract InkSepoliaOwnDexForkTest is OwnDexForkTest {
    function _rpc() internal view override returns (string memory) {
        return vm.envOr("INK_SEPOLIA_RPC_URL", string("https://rpc-gel-sepolia.inkonchain.com"));
    }

    function _label() internal pure override returns (string memory) {
        return "Ink Sepolia";
    }

    function _chainId() internal pure override returns (uint256) {
        return 763373;
    }
}

/// @notice Same run on Ink mainnet, where our DEX coexists with the third-party one
///         rather than replacing it.
contract InkMainnetOwnDexForkTest is OwnDexForkTest {
    function _rpc() internal view override returns (string memory) {
        return vm.envOr("INK_RPC_URL", string("https://rpc-gel.inkonchain.com"));
    }

    function _label() internal pure override returns (string memory) {
        return "Ink mainnet";
    }

    function _chainId() internal pure override returns (uint256) {
        return 57073;
    }
}

/// @notice Robinhood Chain Testnet, where the system was deployed for real on
///         2026-08-30. The live run is the stronger evidence — this exists so a
///         change to the launchpad or the router is caught against this chain's WETH
///         before it costs another deploy, and so the testnet is not the only place
///         the Nitro path is ever exercised.
contract RobinhoodTestnetOwnDexForkTest is OwnDexForkTest {
    function _rpc() internal view override returns (string memory) {
        return vm.envOr("ROBINHOOD_TESTNET_RPC_URL", string("https://rpc.testnet.chain.robinhood.com"));
    }

    function _label() internal pure override returns (string memory) {
        return "Robinhood Chain Testnet";
    }

    function _chainId() internal pure override returns (uint256) {
        return 46630;
    }
}

/// @notice Robinhood mainnet, which nothing is deployed to yet. Running it now is the
///         cheapest part of deciding whether to: it wraps through the proxied WETH the
///         chain's existing venue already names, on a fork, for free.
contract RobinhoodOwnDexForkTest is OwnDexForkTest {
    function _rpc() internal view override returns (string memory) {
        return vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
    }

    function _label() internal pure override returns (string memory) {
        return "Robinhood Chain";
    }

    function _chainId() internal pure override returns (uint256) {
        return 4663;
    }
}
