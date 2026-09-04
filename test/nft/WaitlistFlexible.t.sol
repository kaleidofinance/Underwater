// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterWaitlistFlexible} from "../../src/nft/UnderwaterWaitlistFlexible.sol";
import {Owned} from "../../src/utils/Owned.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The flexible waitlist is the immutable one with the window unlocked.
///         The whole registration and read surface is carried over unchanged —
///         these tests focus on the two things that did change: the window can
///         move, and only the owner can move it. The registration behaviour is
///         covered by Waitlist.t.sol against the immutable contract.
contract WaitlistFlexibleTest is Test {
    event Registered(address indexed who, uint256 position, uint256 at, address indexed referrer);
    event WindowChanged(uint256 opensAt, uint256 closesAt);

    UnderwaterWaitlistFlexible waitlist;

    uint256 opensAt = 1_000_000;
    uint256 closesAt = 1_000_000 + 7 days;

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(opensAt - 1 days);
        waitlist = new UnderwaterWaitlistFlexible(owner, opensAt, closesAt);
        vm.warp(opensAt);
    }

    function test_ownerIsTheDeployerPassedIn() public view {
        assertEq(waitlist.owner(), owner);
    }

    function test_theWindowStartsWithTheDeployedValue() public view {
        assertEq(waitlist.opensAt(), opensAt);
        assertEq(waitlist.closesAt(), closesAt);
    }

    function test_theOwnerCanMoveTheWindow() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit WindowChanged(opensAt + 1 days, closesAt + 2 days);
        waitlist.setWindow(opensAt + 1 days, closesAt + 2 days);

        assertEq(waitlist.opensAt(), opensAt + 1 days);
        assertEq(waitlist.closesAt(), closesAt + 2 days);
    }

    function test_windowIsShutBeforeTheNewOpen() public {
        // Move the open forward; the period before it is not open.
        uint256 later = opensAt + 1 days;
        vm.prank(owner);
        waitlist.setWindow(later, closesAt);

        vm.warp(later - 1);
        assertFalse(waitlist.isOpen());
        vm.expectRevert(UnderwaterWaitlistFlexible.NotOpen.selector);
        vm.prank(alice);
        waitlist.register();
    }

    function test_windowCanBeExtendedToAdmitLateRegistrants() public {
        // Normal window would be over; the owner extends it, and registration
        // works again. This is the exact behaviour the immutable waitlist refuses.
        vm.warp(closesAt + 1);
        assertFalse(waitlist.isOpen());

        vm.prank(owner);
        waitlist.setWindow(opensAt, closesAt + 3 days);

        assertTrue(waitlist.isOpen());
        vm.prank(alice);
        waitlist.register();
        assertEq(waitlist.count(), 1);
    }

    function test_aWindowAlreadyOverIsRejected() public {
        vm.warp(closesAt + 1);
        vm.prank(owner);
        vm.expectRevert(UnderwaterWaitlistFlexible.BadWindow.selector);
        waitlist.setWindow(opensAt, closesAt);

        // And the reversed order is rejected too.
        vm.prank(owner);
        vm.expectRevert(UnderwaterWaitlistFlexible.BadWindow.selector);
        waitlist.setWindow(closesAt, opensAt);
    }

    function test_nonOwnerCannotMoveTheWindow() public {
        vm.prank(alice);
        vm.expectRevert(Owned.NotOwner.selector);
        waitlist.setWindow(opensAt, closesAt);
    }

    function test_setWindowDoesNotTouchTheList() public {
        vm.prank(alice);
        waitlist.register();
        assertEq(waitlist.count(), 1);

        vm.prank(owner);
        waitlist.setWindow(opensAt, closesAt + 1 days);

        assertEq(waitlist.count(), 1);
        (uint256 position,) = waitlist.registrationOf(alice);
        assertEq(position, 1);
    }

    /// @dev The register/read surface is unchanged from the immutable contract:
    ///      self-only registration, no removal, exhaustively enumerable, packed
    ///      position+timestamp. A short smoke of each still-present guarantee,
    ///      on top of the window tests above.
    function test_registrationIsUnchangedFromTheImmutableContract() public {
        vm.prank(alice);
        waitlist.register();
        vm.prank(bob);
        waitlist.registerWith(alice);

        assertEq(waitlist.count(), 2);
        assertEq(waitlist.referralsOf(alice), 1);
        assertEq(waitlist.referrerOf(bob), alice);

        address[] memory list = waitlist.all();
        assertEq(list.length, 2);
        assertEq(list[0], alice);
        assertEq(list[1], bob);

        (bool registered, uint256 position, , , uint256 referrals) = waitlist.standingOf(alice);
        assertTrue(registered);
        assertEq(position, 1);
        assertEq(referrals, 1);
    }

    /// @dev Same EIP-170 guarantee as the immutable waitlist, checked in the suite
    ///      rather than off a build report.
    function test_theFlexibleWaitlistFitsTheDeployedCodeLimit() public view {
        assertLt(address(waitlist).code.length, 24_576, "EIP-170: flexible waitlist");
    }
}
