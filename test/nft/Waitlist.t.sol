// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterWaitlist} from "../../src/nft/UnderwaterWaitlist.sol";
import {Test} from "forge-std/Test.sol";

/// @dev A registrant that is not an EOA. Smart accounts are the wallets a
///      leveraged position is most likely to be run from, so their being able to
///      register is a property worth pinning rather than an accident.
contract SmartAccount {
    function join(UnderwaterWaitlist waitlist) external {
        waitlist.register();
    }
}

/// @notice Waitlist intake: the window, the one-per-address rule, and the
///         enumeration the allowlist tree is built from.
contract WaitlistTest is Test {
    event Registered(address indexed who, uint256 position, uint256 at, address indexed referrer);

    UnderwaterWaitlist waitlist;

    uint256 opensAt = 1_000_000;
    uint256 closesAt = 1_000_000 + 7 days;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        vm.warp(opensAt - 1 days);
        waitlist = new UnderwaterWaitlist(opensAt, closesAt);
        vm.warp(opensAt);
    }

    function _register(address who) internal {
        vm.prank(who);
        waitlist.register();
    }

    // ─── The window ───────────────────────────────────────────────────────

    function test_constructorRejectsAWindowThatCannotAcceptAnybody() public {
        vm.expectRevert(UnderwaterWaitlist.BadWindow.selector);
        new UnderwaterWaitlist(closesAt, opensAt);

        vm.expectRevert(UnderwaterWaitlist.BadWindow.selector);
        new UnderwaterWaitlist(opensAt, opensAt);

        // Already over at deployment: would accept nobody, and only the first
        // person to try would find out.
        vm.warp(closesAt + 1);
        vm.expectRevert(UnderwaterWaitlist.BadWindow.selector);
        new UnderwaterWaitlist(opensAt, closesAt);
    }

    function test_registrationIsShutBeforeTheWindowOpens() public {
        vm.warp(opensAt - 1);
        assertFalse(waitlist.isOpen());

        vm.expectRevert(UnderwaterWaitlist.NotOpen.selector);
        _register(alice);
    }

    function test_registrationIsShutAfterTheWindowCloses() public {
        vm.warp(closesAt + 1);
        assertFalse(waitlist.isOpen());

        vm.expectRevert(UnderwaterWaitlist.Closed.selector);
        _register(alice);
    }

    function test_bothEdgesOfTheWindowAreInclusive() public {
        vm.warp(opensAt);
        assertTrue(waitlist.isOpen());
        _register(alice);

        vm.warp(closesAt);
        assertTrue(waitlist.isOpen());
        _register(bob);

        assertEq(waitlist.count(), 2);
    }

    function test_theWindowIsImmutable() public view {
        assertEq(waitlist.opensAt(), opensAt);
        assertEq(waitlist.closesAt(), closesAt);
    }

    // ─── Registering ──────────────────────────────────────────────────────

    function test_registerRecordsArrivalOrderAndTime() public {
        vm.warp(opensAt + 5);
        _register(alice);
        vm.warp(opensAt + 90);
        _register(bob);

        (uint256 position, uint256 at) = waitlist.registrationOf(alice);
        assertEq(position, 1);
        assertEq(at, opensAt + 5);

        (position, at) = waitlist.registrationOf(bob);
        assertEq(position, 2);
        assertEq(at, opensAt + 90);

        assertTrue(waitlist.isRegistered(alice));
        assertTrue(waitlist.isRegistered(bob));
        assertEq(waitlist.count(), 2);
    }

    function test_anUnregisteredAddressReadsAsZeroRatherThanReverting() public view {
        (uint256 position, uint256 at) = waitlist.registrationOf(carol);
        assertEq(position, 0);
        assertEq(at, 0);
        assertFalse(waitlist.isRegistered(carol));
    }

    function test_registerEmitsThePositionSoAnIndexerNeverCounts() public {
        vm.expectEmit(true, true, false, true);
        emit Registered(alice, 1, opensAt, address(0));
        _register(alice);

        vm.expectEmit(true, true, false, true);
        emit Registered(bob, 2, opensAt, address(0));
        _register(bob);
    }

    function test_anAddressCannotRegisterTwice() public {
        _register(alice);

        vm.expectRevert(UnderwaterWaitlist.AlreadyRegistered.selector);
        _register(alice);

        // Not even on a later day, and the first registration is untouched.
        vm.warp(closesAt - 1);
        vm.expectRevert(UnderwaterWaitlist.AlreadyRegistered.selector);
        _register(alice);

        (uint256 position, uint256 at) = waitlist.registrationOf(alice);
        assertEq(position, 1);
        assertEq(at, opensAt);
        assertEq(waitlist.count(), 1);
    }

    function test_aSmartAccountCanRegisterItself() public {
        SmartAccount account = new SmartAccount();
        account.join(waitlist);

        assertTrue(waitlist.isRegistered(address(account)));
        (uint256 position,) = waitlist.registrationOf(address(account));
        assertEq(position, 1);
    }

    /// @dev Registration is self-only: `register()` takes no address, so there is
    ///      no way to put somebody on the list who did not ask. Pinned as a
    ///      selector check because the absence of a function cannot be called.
    function test_thereIsNoWayToRegisterSomebodyElse() public {
        bytes[4] memory attempts = [
            abi.encodeWithSignature("registerFor(address)", alice),
            abi.encodeWithSignature("register(address)", alice),
            abi.encodeWithSignature("add(address)", alice),
            abi.encodeWithSignature("remove(address)", alice)
        ];

        for (uint256 i; i < attempts.length; ++i) {
            vm.prank(bob);
            (bool ok,) = address(waitlist).call(attempts[i]);
            assertFalse(ok, "the waitlist grew a second-party entry point");
        }

        assertFalse(waitlist.isRegistered(alice));
        assertEq(waitlist.count(), 0);
    }

    function test_theContractHoldsNothing() public {
        assertEq(address(waitlist).balance, 0);

        // No payable entry point: a plain send has nothing to land in.
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(waitlist).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(waitlist).balance, 0);
    }

    // ─── Enumeration ──────────────────────────────────────────────────────

    function test_allReturnsTheListInArrivalOrder() public {
        _register(carol);
        _register(alice);
        _register(bob);

        address[] memory list = waitlist.all();
        assertEq(list.length, 3);
        assertEq(list[0], carol);
        assertEq(list[1], alice);
        assertEq(list[2], bob);
    }

    function test_registrantsPagesAndClampsTheTail() public {
        for (uint160 i = 1; i <= 10; ++i) {
            _register(address(i));
        }

        address[] memory first = waitlist.registrants(0, 4);
        assertEq(first.length, 4);
        assertEq(first[0], address(1));
        assertEq(first[3], address(4));

        // Asking past the end is the tail, not an error: the list can grow
        // between the caller reading `count` and reading the page.
        address[] memory tail = waitlist.registrants(8, 100);
        assertEq(tail.length, 2);
        assertEq(tail[0], address(9));
        assertEq(tail[1], address(10));

        // Exactly at the end is an empty page, which is how a walk terminates.
        assertEq(waitlist.registrants(10, 5).length, 0);
    }

    function test_registrantsRejectsAStartPastTheList() public {
        _register(alice);

        vm.expectRevert(UnderwaterWaitlist.OutOfRange.selector);
        waitlist.registrants(2, 1);
    }

    /// @dev The pages a snapshot tool walks must reassemble into exactly the
    ///      list, or somebody who registered is quietly left out of the tree.
    function testFuzz_pagedReadsReassembleIntoTheWholeList(uint8 members, uint8 pageSize) public {
        members = uint8(bound(members, 1, 40));
        uint256 size = bound(pageSize, 1, 16);

        for (uint160 i = 1; i <= members; ++i) {
            _register(address(uint160(0x1000) + i));
        }

        address[] memory walked = new address[](members);
        uint256 seen;
        while (seen < members) {
            address[] memory page = waitlist.registrants(seen, size);
            assertGt(page.length, 0, "a walk that cannot finish would drop the tail");
            for (uint256 i; i < page.length; ++i) {
                walked[seen + i] = page[i];
            }
            seen += page.length;
        }

        assertEq(seen, waitlist.count());
        address[] memory whole = waitlist.all();
        for (uint256 i; i < members; ++i) {
            assertEq(walked[i], whole[i]);
        }
    }

    // ─── Packing ──────────────────────────────────────────────────────────

    /// @dev Position and timestamp share one slot. They are read back here at
    ///      values large enough to prove the halves do not bleed into each other.
    function test_positionAndTimestampDoNotCollideAtLargeValues() public {
        UnderwaterWaitlist far = new UnderwaterWaitlist(4_000_000_000, 4_000_000_001);
        vm.warp(4_000_000_001);

        vm.prank(alice);
        far.register();

        (uint256 position, uint256 at) = far.registrationOf(alice);
        assertEq(position, 1);
        assertEq(at, 4_000_000_001);
    }

    function testFuzz_registrationRoundTripsThroughThePackedSlot(uint64 when, uint8 before) public {
        uint256 at = bound(when, opensAt, closesAt);
        uint256 ahead = bound(before, 0, 30);

        for (uint160 i = 1; i <= ahead; ++i) {
            _register(address(uint160(0x2000) + i));
        }

        vm.warp(at);
        _register(alice);

        (uint256 position, uint256 stamp) = waitlist.registrationOf(alice);
        assertEq(position, ahead + 1);
        assertEq(stamp, at);
    }

    /// @dev Nowhere near the limit today. Asserted anyway, because the suite's
    ///      claim is that every deployed contract here is checked in the suite
    ///      rather than off a build report, and an exemption is how that stops
    ///      being true.
    function test_theWaitlistFitsTheDeployedCodeLimit() public view {
        assertLt(address(waitlist).code.length, 24_576, "EIP-170: waitlist");
    }

    // ─── Referrals ────────────────────────────────────────────────────────

    function _registerWith(address who, address referrer) internal {
        vm.prank(who);
        waitlist.registerWith(referrer);
    }

    function test_aReferralIsCreditedToTheReferrer() public {
        _register(alice);

        vm.expectEmit(true, true, false, true);
        emit Registered(bob, 2, opensAt, alice);
        _registerWith(bob, alice);

        _registerWith(carol, alice);

        assertEq(waitlist.referralsOf(alice), 2);
        assertEq(waitlist.referrerOf(bob), alice);
        assertEq(waitlist.referrerOf(carol), alice);
        // The referred are ordinary registrants — the credit is the referrer's.
        assertEq(waitlist.referralsOf(bob), 0);
        assertEq(waitlist.referrerOf(alice), address(0));
    }

    /// @dev The whole design rests on this: a referral is a number and nothing
    ///      else. If a referral ever bought standing, every fake registration
    ///      would be worth something, and the selection is what that would cost.
    function test_referralsChangeNothingAboutStanding() public {
        _register(alice);
        _registerWith(bob, alice);

        (uint256 alicePosition,) = waitlist.registrationOf(alice);
        (uint256 bobPosition,) = waitlist.registrationOf(bob);
        assertEq(alicePosition, 1);
        assertEq(bobPosition, 2);

        // Nothing on this contract can be read as an allocation, a weight or a
        // claim. The list the tree is built from is arrival order, unchanged.
        address[] memory list = waitlist.all();
        assertEq(list.length, 2);
        assertEq(list[0], alice);
        assertEq(list[1], bob);
    }

    function test_aReferrerMustAlreadyBeRegistered() public {
        // Otherwise the top of the leaderboard is addresses that never joined.
        vm.expectRevert(UnderwaterWaitlist.BadReferrer.selector);
        _registerWith(bob, alice);

        assertFalse(waitlist.isRegistered(bob));
        assertEq(waitlist.count(), 0);

        _register(alice);
        _registerWith(bob, alice);
        assertTrue(waitlist.isRegistered(bob));
    }

    function test_selfReferralReverts() public {
        vm.expectRevert(UnderwaterWaitlist.BadReferrer.selector);
        _registerWith(alice, alice);

        // Not reachable the long way round either: a second registration is
        // already refused, so there is no order in which this becomes free.
        _register(alice);
        vm.expectRevert(UnderwaterWaitlist.AlreadyRegistered.selector);
        _registerWith(alice, alice);
        assertEq(waitlist.referralsOf(alice), 0);
    }

    /// @dev A mangled link is the likeliest way this function is called in the
    ///      wild, and losing the attribution beats losing the registration.
    function test_aZeroReferrerStillRegisters() public {
        _registerWith(alice, address(0));

        assertTrue(waitlist.isRegistered(alice));
        assertEq(waitlist.referrerOf(alice), address(0));
    }

    function test_referralsCannotBeStackedByOneAddress() public {
        _register(alice);
        _registerWith(bob, alice);

        // One registration, one referral, forever — the one-per-address rule is
        // what caps a referral count at the number of real addresses that joined.
        vm.expectRevert(UnderwaterWaitlist.AlreadyRegistered.selector);
        _registerWith(bob, alice);
        assertEq(waitlist.referralsOf(alice), 1);
    }

    function test_standingOfReturnsThePanelInOneCall() public {
        _register(alice);
        _registerWith(bob, alice);

        (bool registered, uint256 position, uint256 at, address referrer, uint256 referrals) =
            waitlist.standingOf(alice);
        assertTrue(registered);
        assertEq(position, 1);
        assertEq(at, opensAt);
        assertEq(referrer, address(0));
        assertEq(referrals, 1);

        (registered, position, at, referrer, referrals) = waitlist.standingOf(carol);
        assertFalse(registered);
        assertEq(position, 0);
        assertEq(at, 0);
        assertEq(referrer, address(0));
        assertEq(referrals, 0);
    }

    /// @dev A referral chain is allowed and deliberately not credited upward:
    ///      only the direct referrer scores, so a chain cannot multiply itself.
    function test_creditDoesNotPropagateUpAChain() public {
        _register(alice);
        _registerWith(bob, alice);
        _registerWith(carol, bob);

        assertEq(waitlist.referralsOf(alice), 1);
        assertEq(waitlist.referralsOf(bob), 1);
        assertEq(waitlist.referrerOf(carol), bob);
    }

    function test_referralsAreShutOutsideTheWindowLikeEverythingElse() public {
        _register(alice);

        vm.warp(closesAt + 1);
        vm.expectRevert(UnderwaterWaitlist.Closed.selector);
        _registerWith(bob, alice);

        // And the window check runs before the referrer check, so a closed
        // window reports itself rather than blaming the link.
        vm.expectRevert(UnderwaterWaitlist.Closed.selector);
        _registerWith(bob, address(0));
    }
}
