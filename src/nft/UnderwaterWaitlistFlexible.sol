// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Owned} from "../utils/Owned.sol";

/// @title UnderwaterWaitlistFlexible
/// @notice Registration for an allowlist, with an owner-adjustable window.
///
/// This is the mutable-window counterpart to [`UnderwaterWaitlist`]. Every
/// registration and read behaves identically: self-only, one per address, no
/// removal, exhaustively enumerable, referrals recorded but never rewarded on
/// chain. The single difference is the window.
///
/// In the immutable contract, `opensAt` and `closesAt` are fixed at deployment,
/// and that immutability is the point: a settable deadline is a lever over who
/// is eligible, held by whoever owns the contract, *after people have acted on
/// the published one*. This contract deliberately gives that lever to an owner.
/// Use it only where that trade is the one you want. If a registration window
/// must be verifiably beyond anyone's reach, use `UnderwaterWaitlist` instead.
///
/// The owner's only power is `setWindow`. There is no pause, no removal and no
/// way to register an address that did not act for itself — see `register`.
contract UnderwaterWaitlistFlexible is Owned {
    // ─── Errors ───────────────────────────────────────────────────────────

    error NotOpen();
    error Closed();
    error AlreadyRegistered();
    error BadWindow();
    error OutOfRange();
    error BadReferrer();

    // ─── Events ───────────────────────────────────────────────────────────

    /// @notice Emitted once per address, ever.
    /// @param who The registrant. Always `msg.sender` — see `register`.
    /// @param position 1-based arrival order, carried in the log so an indexer
    ///        never has to count.
    /// @param at Registration timestamp.
    /// @param referrer Who brought them in, or `address(0)`. Indexed so a
    ///        referral list is one `getLogs` filter, and carried here as well as
    ///        stored because the *count* is what the page shows and the
    ///        individual attributions are what makes a disputed count checkable.
    event Registered(address indexed who, uint256 position, uint256 at, address indexed referrer);

    /// @notice Emitted whenever the owner moves the window.
    event WindowChanged(uint256 opensAt, uint256 closesAt);

    // ─── Window ───────────────────────────────────────────────────────────

    /// @notice When registration opens. Settable by the owner.
    uint256 public opensAt;

    /// @notice When registration closes. Settable by the owner.
    uint256 public closesAt;

    // ─── State ────────────────────────────────────────────────────────────

    /// @dev Arrival order. Costs the registrant one extra cold slot over a
    ///      log-only design, and buys exhaustive enumeration by `eth_call`:
    ///      building the allowlist from `getLogs` means a dropped range silently
    ///      excludes a real person, and this list decides who gets to mint.
    address[] internal _registrants;

    /// @dev `(at << 128) | position`, packed into the one slot each registrant
    ///      already pays for. Zero means never registered, which is why
    ///      `position` is 1-based.
    mapping(address => uint256) internal _record;

    /// @dev Who referred each registrant, and how many each referrer brought.
    ///      The count is stored rather than derived from logs for the same reason
    ///      `_registrants` is: a leaderboard built from `getLogs` is a
    ///      leaderboard that changes when an RPC drops a range.
    mapping(address => address) internal _referrer;
    mapping(address => uint256) internal _referrals;

    constructor(address _owner, uint256 _opensAt, uint256 _closesAt) Owned(_owner) {
        // A window that is already over would deploy fine and then accept
        // nobody, which is the kind of mistake that is only discovered by the
        // first person who tries.
        if (_closesAt <= _opensAt || _closesAt <= block.timestamp) revert BadWindow();
        opensAt = _opensAt;
        closesAt = _closesAt;
    }

    // ─── Window ───────────────────────────────────────────────────────────

    /// @notice Move the registration window. The only owner-only function.
    ///
    /// @dev Either edge may move, but the close must stay strictly after the
    ///      open and after `now`, so this cannot produce a window that is
    ///      already over and would silently reject everyone. Registered
    ///      addresses are untouched — this changes the window, never the list.
    function setWindow(uint256 _opensAt, uint256 _closesAt) external onlyOwner {
        if (_closesAt <= _opensAt || _closesAt <= block.timestamp) revert BadWindow();
        opensAt = _opensAt;
        closesAt = _closesAt;
        emit WindowChanged(_opensAt, _closesAt);
    }

    // ─── Register ─────────────────────────────────────────────────────────

    /// @notice Put `msg.sender` on the waitlist.
    ///
    /// @dev Self-registration only. A `registerFor(address)` would let anyone
    ///      stuff the list with addresses whose owners never asked, which costs
    ///      them nothing and costs the selection its meaning.
    ///
    ///      Contract accounts are welcome: rejecting them would exclude every
    ///      Safe and every smart account, which are exactly the wallets a
    ///      leveraged position is likely to be run from.
    function register() external {
        _register(address(0));
    }

    /// @notice Register, crediting `referrer` on the leaderboard.
    ///
    /// @dev Credit only, on chain — this contract has no allowlist logic to move,
    ///      and what the credit is worth is decided off chain by the criteria in
    ///      ALLOWLIST.md, which rank by *qualified* referrals. That the number now
    ///      counts for something is exactly why the contract is strict about what
    ///      it will attribute:
    ///
    ///      - **A referrer must already be registered.** Otherwise the top of the
    ///        leaderboard is addresses that never joined, and a referral link
    ///        would work before its owner had one.
    ///      - **Self-referral reverts.** It would be free and it would be
    ///        meaningless.
    ///
    ///      `address(0)` is accepted and simply records no referrer, so a link
    ///      with a mangled parameter still registers the person holding it rather
    ///      than reverting on them. That is the failure this function is most
    ///      likely to meet in the wild, and losing the attribution is a much
    ///      better outcome than losing the registration.
    function registerWith(address referrer) external {
        _register(referrer);
    }

    function _register(address referrer) internal {
        if (block.timestamp < opensAt) revert NotOpen();
        if (block.timestamp > closesAt) revert Closed();
        if (_record[msg.sender] != 0) revert AlreadyRegistered();
        // Checked after the window and after the caller's own status, so a closed
        // window or a repeat registration reports itself rather than blaming the
        // link — the referrer is the least interesting reason any of this failed.
        if (referrer != address(0) && (referrer == msg.sender || _record[referrer] == 0)) {
            revert BadReferrer();
        }

        _registrants.push(msg.sender);
        uint256 position = _registrants.length;
        // Both fields are bounded far below their halves: a timestamp is 32 bits
        // for another 80 years and a position cannot exceed the number of
        // transactions ever sent.
        _record[msg.sender] = (block.timestamp << 128) | position;

        if (referrer != address(0)) {
            _referrer[msg.sender] = referrer;
            unchecked {
                ++_referrals[referrer];
            }
        }

        emit Registered(msg.sender, position, block.timestamp, referrer);
    }

    // ─── Reads ────────────────────────────────────────────────────────────

    /// @notice How many addresses have registered.
    function count() external view returns (uint256) {
        return _registrants.length;
    }

    /// @notice True once `who` has registered.
    function isRegistered(address who) external view returns (bool) {
        return _record[who] != 0;
    }

    /// @notice `who`'s 1-based arrival order and registration time, or `(0, 0)`.
    /// @dev One call rather than two mappings: the page wants to say "you are in,
    ///      number 1412" and both halves live in the slot registration already
    ///      paid for.
    function registrationOf(address who) external view returns (uint256 position, uint256 at) {
        uint256 record = _record[who];
        if (record == 0) return (0, 0);
        return (record & type(uint128).max, record >> 128);
    }

    /// @notice `n` registrants in arrival order, starting at `start`.
    /// @dev Paged so a large list can be read by an RPC with a response limit;
    ///      `count` first, then walk. A short return at the end is the tail, not
    ///      a truncation — `start + n` past the end is clamped rather than
    ///      reverting, because the caller cannot see the list growing under them.
    function registrants(uint256 start, uint256 n) external view returns (address[] memory page) {
        uint256 total = _registrants.length;
        if (start > total) revert OutOfRange();
        uint256 end = start + n;
        if (end > total) end = total;

        page = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = _registrants[i];
        }
    }

    /// @notice The whole list, for anyone rebuilding the tree.
    /// @dev View-only, so its gas is paid by nobody; a caller that cannot take
    ///      the response in one piece has `registrants` above.
    function all() external view returns (address[] memory) {
        return _registrants;
    }

    /// @notice True while `register` would be accepted.
    function isOpen() external view returns (bool) {
        return block.timestamp >= opensAt && block.timestamp <= closesAt;
    }

    // ─── Referrals ────────────────────────────────────────────────────────

    /// @notice How many registrations `who` brought in — the raw referral count.
    ///         The allowlist criteria (ALLOWLIST.md) rank by the *qualified* subset
    ///         of these, not the raw number; this contract stores the tally and
    ///         judges none of it.
    function referralsOf(address who) external view returns (uint256) {
        return _referrals[who];
    }

    /// @notice Who referred `who`, or `address(0)`.
    function referrerOf(address who) external view returns (address) {
        return _referrer[who];
    }

    /// @notice `who`'s whole standing in one call: are they in, at what position,
    ///         when, who brought them, and how many they brought.
    /// @dev The page needs all five at once, and five separate reads over a public
    ///      RPC is five chances to render a half-populated panel.
    function standingOf(address who)
        external
        view
        returns (bool registered, uint256 position, uint256 at, address referrer, uint256 referrals)
    {
        uint256 record = _record[who];
        return (
            record != 0,
            record & type(uint128).max,
            record >> 128,
            _referrer[who],
            _referrals[who]
        );
    }
}
