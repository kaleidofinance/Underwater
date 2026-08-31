// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterPoints as P} from "../src/UnderwaterPoints.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The rate card and the coupon book.
///
/// @dev What is worth testing here is narrow, because most of the points system is
///      not in this contract — balances are counted off chain from logs, and there
///      is nothing on chain to assert about them. What *is* here is state the owner
///      moves and a redemption path a stranger drives, so these tests are about the
///      four ways a coupon can be refused and the two ways ownership can be.
///
///      The `CouponExists` cases carry the most weight. Re-issuing a hash is the
///      one mistake with a silent failure mode on the far side of it: re-point a
///      live code and you have quietly changed what somebody was already promised;
///      re-issue a retired one and everybody in `redeemedBy` is locked out of a
///      code they have never seen. Both look like success from the owner's side.
contract PointsTest is Test {
    P points;

    address owner = address(0xA11CE);
    address alice = address(0xBEEF);
    address bob = address(0xCAFE);

    string constant CODE = "UW-7QK4-9ZTD-1M3X";
    bytes32 immutable CODE_HASH = keccak256(bytes(CODE));

    function _card(uint64 r, uint64 f, uint64 c, uint64 s) internal pure returns (P.Rates memory) {
        return P.Rates({register: r, referral: f, create: c, swap: s});
    }

    function _hashes(string memory code) internal pure returns (bytes32[] memory hs) {
        hs = new bytes32[](1);
        hs[0] = keccak256(bytes(code));
    }

    function setUp() public {
        points = new P(owner, _card(10_000, 1_000, 20_000, 10));
    }

    // ─── Construction ─────────────────────────────────────────────────────

    function test_constructor_setsOwnerAndRates() public view {
        assertEq(points.owner(), owner);

        P.Rates memory r = points.rates();
        assertEq(r.register, 10_000);
        assertEq(r.referral, 1_000);
        assertEq(r.create, 20_000);
        assertEq(r.swap, 10);

        assertEq(points.ratesVersion(), 1);
    }

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(ZeroAddress.selector);
        new P(address(0), _card(1, 1, 1, 1));
    }

    // ─── Rates ────────────────────────────────────────────────────────────

    function test_setRates_movesEveryRateAndBumpsVersion() public {
        vm.prank(owner);
        points.setRates(_card(25_000, 2_500, 50_000, 25));

        P.Rates memory r = points.rates();
        assertEq(r.register, 25_000);
        assertEq(r.referral, 2_500);
        assertEq(r.create, 50_000);
        assertEq(r.swap, 25);
        assertEq(points.ratesVersion(), 2);
    }

    /// @dev A rate of zero is a legitimate setting — it switches an earning off
    ///      without redeploying anything — so it must not be mistaken for unset.
    function test_setRates_acceptsZero() public {
        vm.prank(owner);
        points.setRates(_card(10_000, 1_000, 20_000, 0));
        assertEq(points.rates().swap, 0);
    }

    function test_setRates_ownerOnly() public {
        vm.prank(alice);
        vm.expectRevert(NotOwner.selector);
        points.setRates(_card(1, 1, 1, 1));
    }

    /// @dev The version is a cache key, so what matters is that it never repeats,
    ///      not that it counts anything in particular.
    function test_rateCard_versionIsMonotonic() public {
        uint64 last;
        for (uint64 i = 0; i < 5; ++i) {
            vm.prank(owner);
            points.setRates(_card(i, i, i, i));
            (, uint64 v) = points.rateCard();
            assertGt(v, last);
            last = v;
        }
    }

    // ─── Issue ────────────────────────────────────────────────────────────

    function test_issue_thenRedeem_credits() public {
        vm.prank(owner);
        points.issue(_hashes(CODE), 5_000, 1, address(0));

        (bool exists, bool live, uint64 pts, uint32 uses, address boundTo) =
            points.couponState(CODE_HASH);
        assertTrue(exists);
        assertTrue(live);
        assertEq(pts, 5_000);
        assertEq(uses, 1);
        assertEq(boundTo, address(0));

        vm.prank(alice);
        points.redeem(CODE);

        assertEq(points.granted(alice), 5_000);
        assertTrue(points.redeemedBy(CODE_HASH, alice));

        (, bool stillLive,, uint32 left,) = points.couponState(CODE_HASH);
        assertFalse(stillLive);
        assertEq(left, 0);
    }

    function test_issue_batchAllGetTheSameTerms() public {
        bytes32[] memory hs = new bytes32[](3);
        hs[0] = keccak256("A");
        hs[1] = keccak256("B");
        hs[2] = keccak256("C");

        vm.prank(owner);
        points.issue(hs, 750, 4, address(0));

        for (uint256 i = 0; i < hs.length; ++i) {
            (bool exists,, uint64 pts, uint32 uses,) = points.couponState(hs[i]);
            assertTrue(exists);
            assertEq(pts, 750);
            assertEq(uses, 4);
        }
    }

    function test_issue_ownerOnly() public {
        vm.prank(alice);
        vm.expectRevert(NotOwner.selector);
        points.issue(_hashes(CODE), 1, 1, address(0));
    }

    function test_issue_rejectsEmptyBatch() public {
        vm.prank(owner);
        vm.expectRevert(P.NoCodes.selector);
        points.issue(new bytes32[](0), 1, 1, address(0));
    }

    /// @dev Zero points is refused rather than stored, because `points == 0` is how
    ///      every other path in the contract asks "does this coupon exist" — a
    ///      zero-value coupon would be issued and then invisible.
    function test_issue_rejectsZeroPoints() public {
        vm.prank(owner);
        vm.expectRevert(P.ZeroPoints.selector);
        points.issue(_hashes(CODE), 0, 1, address(0));
    }

    function test_issue_rejectsZeroUses() public {
        vm.prank(owner);
        vm.expectRevert(P.ZeroUses.selector);
        points.issue(_hashes(CODE), 1_000, 0, address(0));
    }

    function test_issue_refusesToRepointALiveCode() public {
        vm.startPrank(owner);
        points.issue(_hashes(CODE), 1_000, 1, address(0));
        vm.expectRevert(P.CouponExists.selector);
        points.issue(_hashes(CODE), 9_000, 1, address(0));
        vm.stopPrank();

        (,, uint64 pts,,) = points.couponState(CODE_HASH);
        assertEq(pts, 1_000, "the original terms must survive a refused re-issue");
    }

    /// @dev The lock-out case. Voiding retires a hash permanently, so this refusal
    ///      is what stops a re-issued code from excluding everyone who redeemed the
    ///      first one.
    function test_issue_refusesToReviveAVoidedCode() public {
        vm.startPrank(owner);
        points.issue(_hashes(CODE), 1_000, 5, address(0));
        points.void(_hashes(CODE));

        vm.expectRevert(P.CouponExists.selector);
        points.issue(_hashes(CODE), 1_000, 5, address(0));
        vm.stopPrank();
    }

    /// @dev Same, for a code that ran out on its own rather than being voided.
    function test_issue_refusesToReviveAnExhaustedCode() public {
        vm.prank(owner);
        points.issue(_hashes(CODE), 1_000, 1, address(0));
        vm.prank(alice);
        points.redeem(CODE);

        vm.prank(owner);
        vm.expectRevert(P.CouponExists.selector);
        points.issue(_hashes(CODE), 1_000, 1, address(0));
    }

    // ─── Redeem ───────────────────────────────────────────────────────────

    function test_redeem_unknownCode() public {
        vm.prank(alice);
        vm.expectRevert(P.NoSuchCoupon.selector);
        points.redeem("not-a-code");
    }

    function test_redeem_spentCode() public {
        vm.prank(owner);
        points.issue(_hashes(CODE), 1_000, 1, address(0));

        vm.prank(alice);
        points.redeem(CODE);

        vm.prank(bob);
        vm.expectRevert(P.CouponSpent.selector);
        points.redeem(CODE);
        assertEq(points.granted(bob), 0);
    }

    function test_redeem_voidedCode() public {
        vm.startPrank(owner);
        points.issue(_hashes(CODE), 1_000, 10, address(0));
        points.void(_hashes(CODE));
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(P.CouponSpent.selector);
        points.redeem(CODE);
    }

    /// @dev The anti-front-running case: a bound code copied out of the mempool is
    ///      worth nothing to whoever copied it.
    function test_redeem_boundCodeRefusesEveryoneElse() public {
        vm.prank(owner);
        points.issue(_hashes(CODE), 3_000, 1, alice);

        vm.prank(bob);
        vm.expectRevert(P.NotYourCoupon.selector);
        points.redeem(CODE);

        vm.prank(alice);
        points.redeem(CODE);
        assertEq(points.granted(alice), 3_000);
    }

    /// @dev The reason `redeemedBy` exists: a multi-use code is for a crowd, and
    ///      one address must not be able to take the crowd's share.
    function test_redeem_oneAddressCannotDrainAMultiUseCode() public {
        vm.prank(owner);
        points.issue(_hashes(CODE), 1_000, 3, address(0));

        vm.prank(alice);
        points.redeem(CODE);

        vm.prank(alice);
        vm.expectRevert(P.AlreadyRedeemed.selector);
        points.redeem(CODE);

        assertEq(points.granted(alice), 1_000);

        vm.prank(bob);
        points.redeem(CODE);
        assertEq(points.granted(bob), 1_000);

        (,,, uint32 left,) = points.couponState(CODE_HASH);
        assertEq(left, 1);
    }

    /// @dev Codes are independent: two coupons must accumulate, not overwrite.
    function test_redeem_grantsAccumulateAcrossCodes() public {
        vm.startPrank(owner);
        points.issue(_hashes("FIRST"), 1_000, 1, address(0));
        points.issue(_hashes("SECOND"), 2_500, 1, address(0));
        vm.stopPrank();

        vm.startPrank(alice);
        points.redeem("FIRST");
        points.redeem("SECOND");
        vm.stopPrank();

        assertEq(points.granted(alice), 3_500);
    }

    /// @dev Whitespace and case are part of a code. Not a nicety — the codes are
    ///      random, and normalising them would shrink the space that makes guessing
    ///      expensive.
    function test_redeem_codeIsExact() public {
        vm.prank(owner);
        points.issue(_hashes(CODE), 1_000, 1, address(0));

        vm.startPrank(alice);
        vm.expectRevert(P.NoSuchCoupon.selector);
        points.redeem("uw-7qk4-9ztd-1m3x");
        vm.expectRevert(P.NoSuchCoupon.selector);
        points.redeem(" UW-7QK4-9ZTD-1M3X");
        vm.stopPrank();
    }

    // ─── Void ─────────────────────────────────────────────────────────────

    function test_void_ownerOnly() public {
        vm.prank(alice);
        vm.expectRevert(NotOwner.selector);
        points.void(_hashes(CODE));
    }

    /// @dev Voiding is not a clawback, and the contract should not pretend it is:
    ///      `granted` only ever goes up.
    function test_void_doesNotClawBack() public {
        vm.prank(owner);
        points.issue(_hashes(CODE), 4_000, 5, address(0));
        vm.prank(alice);
        points.redeem(CODE);

        vm.prank(owner);
        points.void(_hashes(CODE));

        assertEq(points.granted(alice), 4_000);
    }

    // ─── Grant ────────────────────────────────────────────────────────────

    function test_grant_creditsEveryAddress() public {
        address[] memory whos = new address[](2);
        whos[0] = alice;
        whos[1] = bob;

        vm.prank(owner);
        points.grant(whos, 12_345, "bug bounty");

        assertEq(points.granted(alice), 12_345);
        assertEq(points.granted(bob), 12_345);
    }

    function test_grant_addsToCouponPoints() public {
        vm.prank(owner);
        points.issue(_hashes(CODE), 1_000, 1, address(0));
        vm.prank(alice);
        points.redeem(CODE);

        address[] memory whos = new address[](1);
        whos[0] = alice;
        vm.prank(owner);
        points.grant(whos, 500, "trade the indexer lost");

        assertEq(points.granted(alice), 1_500);
    }

    function test_grant_ownerOnly() public {
        address[] memory whos = new address[](1);
        whos[0] = alice;

        vm.prank(alice);
        vm.expectRevert(NotOwner.selector);
        points.grant(whos, 1, "");
    }

    function test_grant_rejectsZeroPoints() public {
        address[] memory whos = new address[](1);
        whos[0] = alice;

        vm.prank(owner);
        vm.expectRevert(P.ZeroPoints.selector);
        points.grant(whos, 0, "");
    }

    /// @dev The zero address cannot hold points and cannot spend them, so crediting
    ///      it is a typo in a list of recipients — worth stopping, because the
    ///      points would be silently lost and the log would look fine.
    function test_grant_rejectsZeroAddress() public {
        address[] memory whos = new address[](2);
        whos[0] = alice;
        whos[1] = address(0);

        vm.prank(owner);
        vm.expectRevert(ZeroAddress.selector);
        points.grant(whos, 100, "");
    }

    // ─── Ownership ────────────────────────────────────────────────────────

    function test_ownership_handoverIsTwoStep() public {
        vm.prank(owner);
        points.transferOwnership(alice);
        assertEq(points.owner(), owner, "nomination alone must not move ownership");

        vm.prank(alice);
        points.acceptOwnership();
        assertEq(points.owner(), alice);

        vm.prank(alice);
        points.setRates(_card(1, 2, 3, 4));
        assertEq(points.rates().create, 3);

        vm.prank(owner);
        vm.expectRevert(NotOwner.selector);
        points.setRates(_card(9, 9, 9, 9));
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────

    /// @dev The rate card is stored packed, so the property that matters is that a
    ///      value goes in and the same value comes out — a mis-declared field order
    ///      would show up as one rate reading another's number.
    function testFuzz_rates_roundTrip(uint64 r, uint64 f, uint64 c, uint64 s) public {
        vm.prank(owner);
        points.setRates(_card(r, f, c, s));

        P.Rates memory got = points.rates();
        assertEq(got.register, r);
        assertEq(got.referral, f);
        assertEq(got.create, c);
        assertEq(got.swap, s);
    }

    /// @dev `Coupon` is packed the same way, and `uses` is the field that gets
    ///      written back on every redemption.
    function testFuzz_coupon_roundTripAndDecrement(uint64 pts, uint32 uses, address boundTo)
        public
    {
        pts = uint64(bound(pts, 1, type(uint64).max));
        uses = uint32(bound(uses, 1, type(uint32).max));
        vm.assume(boundTo != address(0));

        vm.prank(owner);
        points.issue(_hashes(CODE), pts, uses, boundTo);

        (, bool live, uint64 gotPts, uint32 gotUses, address gotBound) =
            points.couponState(CODE_HASH);
        assertTrue(live);
        assertEq(gotPts, pts);
        assertEq(gotUses, uses);
        assertEq(gotBound, boundTo);

        vm.prank(boundTo);
        points.redeem(CODE);

        (,,, uint32 afterUses,) = points.couponState(CODE_HASH);
        assertEq(afterUses, uses - 1);
        assertEq(points.granted(boundTo), pts);
    }

    /// @dev A crowd code should pay every distinct redeemer exactly once and run
    ///      out at exactly its use count, with no off-by-one at the last use.
    function testFuzz_multiUse_paysEachRedeemerOnceAndRunsOut(uint8 seats, uint8 comers) public {
        uint32 uses = uint32(bound(seats, 1, 24));
        uint256 n = bound(comers, 1, 32);

        vm.prank(owner);
        points.issue(_hashes(CODE), 100, uses, address(0));

        uint256 paid;
        for (uint256 i = 0; i < n; ++i) {
            address who = address(uint160(0x1000 + i));
            if (paid < uses) {
                vm.prank(who);
                points.redeem(CODE);
                ++paid;
                assertEq(points.granted(who), 100);
            } else {
                vm.prank(who);
                vm.expectRevert(P.CouponSpent.selector);
                points.redeem(CODE);
                assertEq(points.granted(who), 0);
            }
        }

        (,,, uint32 left,) = points.couponState(CODE_HASH);
        assertEq(left, uses - paid);
    }
}

/// @dev `Owned`'s errors, redeclared so the tests can name them. They are declared
///      on the abstract base rather than on `UnderwaterPoints`, so `P.NotOwner` does
///      not resolve and a bare selector would be a magic number.
error NotOwner();
error ZeroAddress();
