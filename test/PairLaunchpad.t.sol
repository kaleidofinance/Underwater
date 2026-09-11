// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterPairLaunchpad} from "../src/UnderwaterPairLaunchpad.sol";
import {UnderwaterFactory} from "../src/dex/UnderwaterFactory.sol";
import {UnderwaterRouter} from "../src/dex/UnderwaterRouter.sol";
import {MemeToken} from "../src/token/MemeToken.sol";
import {ERC20} from "../src/utils/ERC20.sol";
import {WETH9, TestERC20, TaxToken} from "./dex/mocks/DexMocks.sol";
import {Test} from "forge-std/Test.sol";

/// @notice A 6-decimal token, to prove the launchpad refuses non-18 quotes.
contract SixDecimalToken is ERC20 {
    constructor() ERC20("Six", "SIX", 6) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice The equity-pair launchpad end to end on the real Underwater DEX:
///         a curve quoted in an ERC-20 fills, splits its fee three ways, banks
///         the creator's cut, and graduates into a token/quote pool.
contract PairLaunchpadTest is Test {
    UnderwaterPairLaunchpad internal pad;
    UnderwaterFactory internal factory;
    UnderwaterRouter internal router;
    WETH9 internal weth;
    TestERC20 internal quote;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal whale = makeAddr("whale");
    address internal bob = makeAddr("bob");

    uint256 internal constant TRADE_FEE_BPS = 100; // 1%
    uint256 internal constant GRAD_FEE_BPS = 500; // 5%
    // Default split of the trade fee: protocol 30 / buyback&burn 20 / creator 50.
    uint256 internal constant PROTOCOL_BPS = 3_000;
    uint256 internal constant BURN_BPS = 2_000;
    uint256 internal constant CREATOR_BPS = 5_000;

    // Mirror the ETH curve: 4 quote to graduate, 1 quote virtual reserve.
    uint256 internal constant GRAD_QUOTE = 4e18;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        factory = new UnderwaterFactory(owner);
        weth = new WETH9();
        router = new UnderwaterRouter(address(factory), address(weth));
        pad = new UnderwaterPairLaunchpad(
            owner,
            address(router),
            treasury,
            TRADE_FEE_BPS,
            0, // creationFee
            GRAD_FEE_BPS,
            PROTOCOL_BPS,
            BURN_BPS,
            CREATOR_BPS
        );

        quote = new TestERC20("Tokenized TSLA", "mTSLA");
        vm.prank(owner);
        pad.setPairTokenEconomics(address(quote), GRAD_QUOTE);

        vm.warp(1_700_000_000);

        quote.mint(creator, 1_000e18);
        quote.mint(whale, 1_000e18);
        quote.mint(bob, 1_000e18);
        vm.prank(creator);
        quote.approve(address(pad), type(uint256).max);
        vm.prank(whale);
        quote.approve(address(pad), type(uint256).max);
        vm.prank(bob);
        quote.approve(address(pad), type(uint256).max);
    }

    function _launch() internal returns (address token) {
        vm.prank(creator);
        return pad.create("Pair Frog", "PFROG", "ipfs://frog", address(quote), 0, 0);
    }

    function _graduated(address token) internal view returns (bool g) {
        (,,,,,,,, g,) = pad.pools(token);
    }

    // ─── Create ─────────────────────────────────────────────────────────────

    function test_createSnapshotsEconomics() public {
        address token = _launch();
        (
            address qt,
            uint128 quoteReserve,
            ,
            uint128 realRaised,
            uint128 gradQuote,
            ,
            address c,
            ,
            bool graduated,
            bool exists
        ) = pad.pools(token);
        assertEq(qt, address(quote));
        assertEq(quoteReserve, uint128(GRAD_QUOTE / 4)); // virtual = threshold / 4
        assertEq(gradQuote, uint128(GRAD_QUOTE));
        assertEq(realRaised, 0);
        assertEq(c, creator);
        assertFalse(graduated);
        assertTrue(exists);
    }

    function test_createRejectsUnpricedQuote() public {
        TestERC20 other = new TestERC20("Random", "RND");
        vm.prank(creator);
        vm.expectRevert(UnderwaterPairLaunchpad.QuoteNotApproved.selector);
        pad.create("X", "X", "ipfs://x", address(other), 0, 0);
    }

    function test_createRejectsNon18DecimalQuote() public {
        SixDecimalToken six = new SixDecimalToken();
        vm.prank(owner);
        pad.setPairTokenEconomics(address(six), GRAD_QUOTE);
        vm.prank(creator);
        vm.expectRevert(UnderwaterPairLaunchpad.QuoteNotEighteenDecimals.selector);
        pad.create("X", "X", "ipfs://x", address(six), 0, 0);
    }

    // ─── Fee split ──────────────────────────────────────────────────────────

    function test_buySplitsFeeThreeWays() public {
        address token = _launch();

        uint256 quoteIn = 1e18;
        uint256 fee = quoteIn * TRADE_FEE_BPS / 10_000; // 0.01e18
        uint256 expProtocol = fee * PROTOCOL_BPS / 10_000;
        uint256 expBurn = fee * BURN_BPS / 10_000;
        uint256 expCreator = fee - expProtocol - expBurn;

        vm.prank(whale);
        pad.buy(token, quoteIn, 0, whale);

        assertEq(quote.balanceOf(treasury), expProtocol, "protocol paid on the spot");
        assertEq(pad.buybackReserve(address(quote)), expBurn, "burn share accrued");
        assertEq(pad.creatorTreasury(creator, address(quote)), expCreator, "creator banked");
        assertEq(pad.creatorTreasuryTotal(address(quote)), expCreator);
        // The three parts re-sum to the whole fee, no dust unassigned.
        assertEq(expProtocol + expBurn + expCreator, fee);
    }

    function test_creatorClaimsBankedTreasury() public {
        address token = _launch();
        vm.prank(whale);
        pad.buy(token, 1e18, 0, whale);

        uint256 banked = pad.creatorTreasury(creator, address(quote));
        assertGt(banked, 0);

        uint256 before = quote.balanceOf(creator);
        vm.prank(creator);
        pad.claimTreasury(address(quote), creator);

        assertEq(quote.balanceOf(creator), before + banked);
        assertEq(pad.creatorTreasury(creator, address(quote)), 0);
        assertEq(pad.creatorTreasuryTotal(address(quote)), 0);
    }

    // ─── Buy / sell round trip ──────────────────────────────────────────────

    function test_sellReturnsQuoteNetOfFee() public {
        address token = _launch();
        vm.prank(whale);
        uint256 bought = pad.buy(token, 1e18, 0, whale);

        vm.startPrank(whale);
        MemeToken(token).approve(address(pad), bought);
        uint256 before = quote.balanceOf(whale);
        uint256 got = pad.sell(token, bought, 0, whale);
        vm.stopPrank();

        assertEq(quote.balanceOf(whale), before + got);
        assertGt(got, 0);
    }

    // ─── Guards ─────────────────────────────────────────────────────────────

    function test_feeOnTransferQuoteRejected() public {
        TaxToken tax = new TaxToken();
        vm.prank(owner);
        pad.setPairTokenEconomics(address(tax), GRAD_QUOTE);
        vm.prank(creator);
        address token = pad.create("Taxed", "TAX", "ipfs://t", address(tax), 0, 0);

        tax.mint(whale, 100e18);
        vm.startPrank(whale);
        tax.approve(address(pad), type(uint256).max);
        vm.expectRevert(UnderwaterPairLaunchpad.InexactTransfer.selector);
        pad.buy(token, 1e18, 0, whale);
        vm.stopPrank();
    }

    function test_buybackRevertsUntilWaterLive() public {
        address token = _launch();
        vm.prank(whale);
        pad.buy(token, 1e18, 0, whale);

        address[] memory path = new address[](2);
        path[0] = address(quote);
        path[1] = makeAddr("water");

        vm.expectRevert(UnderwaterPairLaunchpad.WaterNotLive.selector);
        pad.buybackAndBurn(address(quote), 0, path);
    }

    // ─── Graduation ─────────────────────────────────────────────────────────

    function test_graduatesIntoTokenQuotePool() public {
        address token = _launch();

        // Buy past the 4-quote net threshold; the buy sizes down to land on it.
        vm.prank(whale);
        pad.buy(token, 5e18, 0, whale);

        assertTrue(_graduated(token), "curve graduated");

        address pair = factory.getPair(token, address(quote));
        assertTrue(pair != address(0), "pool created on the DEX");
        // LP is burned: the launchpad keeps none, and every LP token except the
        // 1000-wei MINIMUM_LIQUIDITY the pair locks at address(0) sits at DEAD.
        uint256 lpSupply = ERC20(pair).totalSupply();
        assertGt(lpSupply, 0);
        assertEq(ERC20(pair).balanceOf(address(pad)), 0, "launchpad holds no LP");
        assertEq(
            ERC20(pair).balanceOf(DEAD) + ERC20(pair).balanceOf(address(0)),
            lpSupply,
            "all LP burned or minimum-locked"
        );
        assertGt(ERC20(pair).balanceOf(DEAD), 0, "LP burned to dead");
        // Graduation fee reached the protocol.
        assertGt(quote.balanceOf(treasury), 0);
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    function test_setFeeSplitMustSumToDenominator() public {
        vm.prank(owner);
        vm.expectRevert(UnderwaterPairLaunchpad.BadFeeSplit.selector);
        pad.setFeeSplit(4_000, 4_000, 4_000);

        vm.prank(owner);
        pad.setFeeSplit(2_000, 3_000, 5_000);
        assertEq(pad.protocolShareBps(), 2_000);
        assertEq(pad.burnShareBps(), 3_000);
        assertEq(pad.creatorShareBps(), 5_000);
    }
}
