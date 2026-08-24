// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterLaunchpad} from "../../src/UnderwaterLaunchpad.sol";
import {MemeToken} from "../../src/token/MemeToken.sol";
import {Test} from "forge-std/Test.sol";

interface IPair {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
}

interface IFactory {
    function getPair(address, address) external view returns (address);
    function allPairsLength() external view returns (uint256);
}

interface IRouter {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
}

/// @notice End-to-end graduation against the live Ink mainnet DEX.
///
/// The unit tests prove the curve against a mock router. This one proves the
/// part a mock cannot: that the real router on Ink accepts our liquidity, that
/// the pair ends up holding it, that the LP position is genuinely burned, and
/// that a stranger can then trade the token on the open market.
///
/// Skipped automatically when the RPC is unreachable, so `forge test` stays
/// green offline. Run explicitly with:
///   forge test --match-contract InkForkGraduationTest -vv
contract InkForkGraduationTest is Test {
    /// @dev Canonical Uniswap-V2 router on Ink mainnet: 1.2M+ transactions,
    ///      factory 0x458C...f95D, which serves the large majority of V2 pairs
    ///      on the chain. Discovered on-chain, not from documentation.
    address constant ROUTER = 0xA8C1C38FF57428e5C3a34E0899Be5Cb385476507;

    /// @dev Standard OP Stack WETH predeploy.
    address constant WETH = 0x4200000000000000000000000000000000000006;

    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    UnderwaterLaunchpad pad;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address whale = makeAddr("whale");
    address stranger = makeAddr("stranger");

    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("INK_RPC_URL", string("https://rpc-gel.inkonchain.com"));
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            emit log("Ink RPC unreachable - skipping fork test");
            return;
        }

        pad = new UnderwaterLaunchpad(owner, ROUTER, treasury, 100, 0, 500);
        vm.deal(whale, 100 ether);
        vm.deal(stranger, 10 ether);
        vm.deal(creator, 1 ether);
    }

    function test_forkEnvironmentIsInk() public {
        if (!forked) return;
        assertEq(block.chainid, 57073, "must be forked onto Ink mainnet");
        assertEq(IRouter(ROUTER).WETH(), WETH, "router WETH must be the OP predeploy");
        assertGt(IFactory(IRouter(ROUTER).factory()).allPairsLength(), 100, "router must be a live DEX");
    }

    function test_fullLifecycleOnRealDex() public {
        if (!forked) return;

        IFactory factory = IFactory(IRouter(ROUTER).factory());
        uint256 pairsBefore = factory.allPairsLength();

        // ── Launch ────────────────────────────────────────────────────────
        vm.prank(creator);
        address token = pad.create("Ink Squid", "SQUID", "ipfs://squid", 0);
        assertEq(factory.getPair(token, WETH), address(0), "no pair before graduation");

        // ── Fund the curve to graduation ──────────────────────────────────
        vm.prank(whale);
        uint256 bought = pad.buy{value: 5 ether}(token, 0, whale);
        assertGt(bought, 0);

        (,,,,,, bool graduated,) = pad.pools(token);
        assertTrue(graduated, "must graduate against the real router");

        // ── The pair now exists and holds our liquidity ───────────────────
        address pair = factory.getPair(token, WETH);
        assertTrue(pair != address(0), "real pair created");
        assertEq(factory.allPairsLength(), pairsBefore + 1, "exactly one new pair");
        assertEq(MemeToken(token).balanceOf(pair), pad.LP_SUPPLY(), "LP allocation in the pool");

        uint256 expectedEth = pad.GRADUATION_ETH() - (pad.GRADUATION_ETH() * 500) / 10_000;
        (uint112 r0, uint112 r1,) = IPair(pair).getReserves();
        uint256 wethReserve = IPair(pair).token0() == WETH ? r0 : r1;
        assertEq(wethReserve, expectedEth, "3.8 ETH of real liquidity");

        // ── The LP position is unrecoverable ──────────────────────────────
        uint256 burned = IPair(pair).balanceOf(DEAD);
        assertGt(burned, 0, "LP must be burned");
        assertEq(IPair(pair).balanceOf(address(pad)), 0, "launchpad holds no LP");
        assertEq(IPair(pair).balanceOf(creator), 0, "creator holds no LP");
        // Only the pair's own MINIMUM_LIQUIDITY lock sits outside the burn sink.
        assertGe(burned + 1000, IPair(pair).totalSupply(), "all minted LP was burned");

        // ── Nothing is left behind in the launchpad ───────────────────────
        assertEq(address(pad).balance, 0, "no ETH stranded");
        assertEq(MemeToken(token).balanceOf(address(pad)), 0, "no tokens stranded");
        assertEq(pad.totalCurveEth(), 0);

        // ── A stranger can now trade it on the open market ────────────────
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = token;

        vm.prank(stranger);
        IRouter(ROUTER).swapExactETHForTokens{value: 0.5 ether}(1, path, stranger, block.timestamp + 300);

        assertGt(MemeToken(token).balanceOf(stranger), 0, "token trades on the real DEX");
    }

    /// @dev Graduation must work even when someone front-ran us by creating the
    ///      pair and seeding it at a deliberately skewed ratio.
    function test_frontRunPairDoesNotStrandTheRaise() public {
        if (!forked) return;

        vm.prank(creator);
        address token = pad.create("Front Run", "FRUN", "ipfs://frun", 0);

        // Attacker buys a little, then seeds the pair at an absurd ratio.
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 10 ether);
        vm.prank(attacker);
        uint256 attackerTokens = pad.buy{value: 0.1 ether}(token, 0, attacker);

        vm.startPrank(attacker);
        MemeToken(token).approve(ROUTER, attackerTokens);
        // Tiny token amount against meaningful ETH: a wildly skewed price.
        (bool ok,) = ROUTER.call{value: 1 ether}(
            abi.encodeWithSignature(
                "addLiquidityETH(address,uint256,uint256,uint256,address,uint256)",
                token,
                attackerTokens / 2,
                0,
                0,
                attacker,
                block.timestamp + 300
            )
        );
        vm.stopPrank();
        assertTrue(ok, "attacker seeded the pair");

        // Graduation must still complete and strand nothing.
        vm.prank(whale);
        pad.buy{value: 6 ether}(token, 0, whale);

        (,,,,,, bool graduated,) = pad.pools(token);
        assertTrue(graduated, "graduates despite the skewed pair");
        assertEq(address(pad).balance, 0, "no ETH stranded");
        assertEq(MemeToken(token).balanceOf(address(pad)), 0, "no tokens stranded");

        // Whatever the pool declined was burned, not left recoverable.
        address pair = IFactory(IRouter(ROUTER).factory()).getPair(token, WETH);
        assertGt(IPair(pair).balanceOf(DEAD), 0, "our LP was burned");
    }
}
