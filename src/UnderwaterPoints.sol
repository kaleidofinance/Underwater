// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Owned} from "./utils/Owned.sol";

/// @title UnderwaterPoints — the uwPoint rate card and coupon book
///
/// @notice The editable half of the points system. Everything else is arithmetic
///         over logs the other contracts already emit.
///
/// @dev **This contract does not store balances, and that is the design.**
///
///      Every action that earns uwPoints is already an indexed event on a
///      contract that is deployed and immutable:
///
///      | earning            | event                                    | filter     |
///      | ------------------ | ---------------------------------------- | ---------- |
///      | registering        | `UnderwaterWaitlist.Registered(who, …)`  | `who`      |
///      | referring someone  | `Registered(…, referrer)`                | `referrer` |
///      | launching a token  | `UnderwaterLaunchpad.TokenCreated(…)`    | `creator`  |
///      | trading the curve  | `UnderwaterLaunchpad.Trade(…)`           | `trader`   |
///      | swapping on the AMM| `UnderwaterPair.Swap(…)`                 | `to`       |
///
///      So a balance is a pure function — `rates × counts + granted[who]` — and
///      this contract only has to hold the two things that function cannot derive:
///      the rates, and points handed out by hand.
///
///      What that buys, and it is the reason for the shape:
///
///      - **Retroactive by construction.** Deploying this credits every launch and
///        every trade that has already happened. There is no "points start now",
///        no migration, and no backfill script to get wrong.
///      - **Re-rating is instant.** `setRates` moves every balance on the next
///        read. A ledger would have to be recomputed, and a ledger that has
///        already paid out at the old rate cannot be.
///      - **No double-credit.** There is no `award()` for a bug to call twice. A
///        trade counted twice would need the chain to contain the log twice.
///      - **Anyone can check it.** The inputs are public logs and four public
///        numbers, so a balance is reproducible by someone who does not trust us.
///
///      What it costs, stated plainly: an off-chain reader has to do the counting,
///      so the *displayed* balance is only as good as that reader. Nothing here
///      can be treated as settled on-chain state. When uwPoints are exchanged for
///      $WATER, the claim will work the way the plates allowlist already does — a
///      snapshot committed as a merkle root, published with the numbers that went
///      into it — not by reading a balance out of this contract, because there is
///      none to read.
///
/// @dev **No ceilings on the rates.** The launchpad caps its fee setters because a
///      fee takes money out of someone's wallet and a fat-fingered 200% would be
///      theft. A rate here mints a number in a spreadsheet the owner already
///      controls, and the owner can hand out arbitrary points with `grant` in any
///      case, so a ceiling would guard nothing while implying a promise this
///      contract cannot keep.
contract UnderwaterPoints is Owned {
    // ─── Types ────────────────────────────────────────────────────────────

    /// @notice What each action is worth, in whole uwPoints.
    /// @dev One slot, and read as one struct, because the page needs all four to
    ///      show a single balance and four separate reads over a public RPC is
    ///      four chances to render a total that adds up to nothing real.
    ///
    ///      `uint64` because the largest sensible rate is thousands and the
    ///      smallest interesting count is one — a rate that overflowed 64 bits
    ///      would be a typo, and the cast at the setter is where a typo of that
    ///      size stops.
    struct Rates {
        /// Awarded once, for being registered on the waitlist at all.
        uint64 register;
        /// Per *valid* referral. Which referrals are valid is decided off chain by
        /// the published criteria — the same activity bar the register form's
        /// check uses — because it depends on wallet history this chain cannot see.
        uint64 referral;
        /// Per token launched on the launchpad.
        uint64 create;
        /// Per trade: one curve buy or sell, or one AMM swap.
        uint64 swap;
    }

    /// @notice A coupon, keyed by `keccak256(bytes(code))`.
    /// @dev Also one slot: 8 + 4 + 20 = 32 bytes, in declaration order.
    struct Coupon {
        /// Points paid out per redemption. Non-zero for a coupon that exists —
        /// this is the field `issue` and `redeem` test existence with.
        uint64 points;
        /// Redemptions left. Decremented on each one; zero is spent, not absent.
        uint32 uses;
        /// If set, the only address that may redeem this code. See the
        /// front-running note on `redeem`.
        address boundTo;
    }

    // ─── Events ───────────────────────────────────────────────────────────

    event RatesUpdated(Rates previous, Rates current, uint64 version);

    /// @dev The hash, never the code — a code in a log is a code anyone can spend.
    event CouponIssued(bytes32 indexed codeHash, uint64 points, uint32 uses, address boundTo);
    event CouponVoided(bytes32 indexed codeHash);
    event Redeemed(address indexed who, bytes32 indexed codeHash, uint64 points);
    event Granted(address indexed who, uint256 points, string reason);

    // ─── Errors ───────────────────────────────────────────────────────────

    error NoSuchCoupon();
    error CouponSpent();
    error CouponExists();
    error NotYourCoupon();
    error AlreadyRedeemed();
    error ZeroPoints();
    error ZeroUses();
    error NoCodes();

    // ─── State ────────────────────────────────────────────────────────────

    Rates internal _rates;

    /// @notice Bumped on every `setRates`.
    /// @dev For cache keys, not for accounting. Computing a leaderboard means
    ///      counting every log on the chain, which is far too slow to do per
    ///      request; a reader caches the result, and this is what tells it the
    ///      cached total was priced at rates that no longer apply.
    uint64 public ratesVersion;

    /// @notice Coupon by code hash. `points == 0` means no such coupon.
    mapping(bytes32 => Coupon) public coupons;

    /// @notice Which addresses have redeemed a given code.
    /// @dev So one address cannot drain a multi-use code on its own. Deliberately
    ///      never cleared, which is why `void` retires a code rather than freeing
    ///      it: re-issuing a spent hash would silently exclude everyone who had
    ///      already redeemed the old one.
    mapping(bytes32 => mapping(address => bool)) public redeemedBy;

    /// @notice Points that are not derivable from logs: redeemed coupons, and
    ///         anything handed out by hand.
    /// @dev The one number an off-chain reader has to *read* rather than count.
    ///      Cumulative and never decremented — see the contract note on why there
    ///      is no spend.
    mapping(address => uint256) public granted;

    // ─── Construction ─────────────────────────────────────────────────────

    constructor(address _owner, Rates memory initial) Owned(_owner) {
        _rates = initial;
        ratesVersion = 1;
        emit RatesUpdated(Rates(0, 0, 0, 0), initial, 1);
    }

    // ─── Reads ────────────────────────────────────────────────────────────

    /// @notice The whole rate card in one call.
    function rates() external view returns (Rates memory) {
        return _rates;
    }

    /// @notice The rate card and its version, for a reader that is caching.
    function rateCard() external view returns (Rates memory card, uint64 version) {
        return (_rates, ratesVersion);
    }

    /// @notice A coupon's state without the tuple-unpacking the public mapping
    ///         getter forces on a caller that only wants to know if it is live.
    /// @param codeHash `keccak256(bytes(code))`.
    /// @return exists True once issued, whether or not it has uses left.
    /// @return live   True while `redeem` would accept it from *somebody*.
    /// @return points What one redemption pays.
    /// @return uses   Redemptions left.
    /// @return boundTo The single permitted redeemer, or the zero address.
    function couponState(bytes32 codeHash)
        external
        view
        returns (bool exists, bool live, uint64 points, uint32 uses, address boundTo)
    {
        Coupon memory c = coupons[codeHash];
        return (c.points != 0, c.points != 0 && c.uses != 0, c.points, c.uses, c.boundTo);
    }

    // ─── Owner ────────────────────────────────────────────────────────────

    /// @notice Re-price every action, retroactively and for everyone.
    /// @dev Retroactive is not a side effect. Balances are `rates × counts`, so
    ///      there is no version of this that only applies going forward, and
    ///      pretending otherwise is how a leaderboard ends up with two kinds of
    ///      point in it.
    function setRates(Rates calldata card) external onlyOwner {
        Rates memory previous = _rates;
        _rates = card;
        emit RatesUpdated(previous, card, ++ratesVersion);
    }

    /// @notice Issue one batch of coupons, all worth the same.
    ///
    /// @param codeHashes `keccak256(bytes(code))` for each code. Hash off chain:
    ///        calldata is public, so passing plaintext would publish the codes to
    ///        anyone reading the mempool before a single one was handed out.
    /// @param points Paid per redemption.
    /// @param uses How many times *in total* each code in this batch may be
    ///        redeemed, once each per address. `1` is a code for one person.
    /// @param boundTo The only address allowed to redeem, or the zero address for
    ///        a code anybody holding it can use.
    ///
    /// @dev Refuses a hash that has been issued before, spent or not. Re-pointing
    ///      a live code would change what someone was already promised, and
    ///      re-issuing a retired one would lock out everyone in `redeemedBy` —
    ///      both are quiet failures, so this is a loud one. Issue a new code.
    function issue(bytes32[] calldata codeHashes, uint64 points, uint32 uses, address boundTo)
        external
        onlyOwner
    {
        if (codeHashes.length == 0) revert NoCodes();
        if (points == 0) revert ZeroPoints();
        if (uses == 0) revert ZeroUses();

        for (uint256 i = 0; i < codeHashes.length; ++i) {
            bytes32 h = codeHashes[i];
            if (coupons[h].points != 0) revert CouponExists();
            coupons[h] = Coupon(points, uses, boundTo);
            emit CouponIssued(h, points, uses, boundTo);
        }
    }

    /// @notice Retire codes — a leaked batch, or a campaign that is over.
    /// @dev Sets uses to zero rather than deleting, so the hash stays claimed and
    ///      cannot be re-issued. Already-redeemed points are not clawed back;
    ///      `granted` only goes up.
    function void(bytes32[] calldata codeHashes) external onlyOwner {
        for (uint256 i = 0; i < codeHashes.length; ++i) {
            coupons[codeHashes[i]].uses = 0;
            emit CouponVoided(codeHashes[i]);
        }
    }

    /// @notice Credit points directly, with a note saying why.
    /// @dev The escape hatch, and the honest one: it is in the open, it is in a
    ///      log with its own reason string, and it is the same `granted` a coupon
    ///      pays into, so nothing about a balance is hidden from someone checking
    ///      the arithmetic. Bug bounties, a trade the indexer lost, a contest.
    function grant(address[] calldata whos, uint256 points, string calldata reason)
        external
        onlyOwner
    {
        if (points == 0) revert ZeroPoints();
        for (uint256 i = 0; i < whos.length; ++i) {
            if (whos[i] == address(0)) revert ZeroAddress();
            granted[whos[i]] += points;
            emit Granted(whos[i], points, reason);
        }
    }

    // ─── Redeem ───────────────────────────────────────────────────────────

    /// @notice Redeem a coupon code for its points.
    ///
    /// @dev **A code in an unbound transaction is a code in the mempool.** Anyone
    ///      watching can copy it out of a pending `redeem` and land their own
    ///      first, which for a one-use code means they get the points and the
    ///      holder gets a revert. There is no fix for that inside a single
    ///      transaction — the contract has to see the code to check it.
    ///
    ///      So the shape of the coupon is the mitigation, and it is why `issue`
    ///      takes both `uses` and `boundTo`:
    ///
    ///      - A code for one known person should be issued with `boundTo` set.
    ///        Then a copied code is worthless, and front-running is dead.
    ///      - A code for a crowd should be issued with `uses` well above one.
    ///        Racing for one of five hundred is not worth a bot.
    ///      - A one-use unbound code is the one combination that is exposed. It is
    ///        allowed because it is genuinely useful — a code printed on a sticker,
    ///        given out at an event — and the risk is small and self-limiting.
    ///
    ///      Codes must also be high-entropy. `couponState` will tell anyone
    ///      whether a hash is live, and this function's errors distinguish "never
    ///      issued" from "spent" because a person typing a code needs to know
    ///      which. Both make guessing cheap to check, so guessing has to be
    ///      expensive to do: generate codes at random, do not derive them from
    ///      names or dates.
    function redeem(string calldata code) external {
        bytes32 h = keccak256(bytes(code));
        Coupon memory c = coupons[h];

        if (c.points == 0) revert NoSuchCoupon();
        if (c.uses == 0) revert CouponSpent();
        if (c.boundTo != address(0) && c.boundTo != msg.sender) revert NotYourCoupon();
        if (redeemedBy[h][msg.sender]) revert AlreadyRedeemed();

        redeemedBy[h][msg.sender] = true;
        coupons[h].uses = c.uses - 1;
        granted[msg.sender] += c.points;

        emit Redeemed(msg.sender, h, c.points);
    }
}
