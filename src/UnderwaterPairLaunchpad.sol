// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUnderwaterRouter, IUnderwaterFactory, IERC20Minimal} from "./dex/interfaces/IUnderwaterDex.sol";
import {SafeTransferLib} from "./dex/libraries/SafeTransferLib.sol";
import {CurveMath} from "./lib/CurveMath.sol";
import {MemeToken} from "./token/MemeToken.sol";
import {Owned} from "./utils/Owned.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";

/// @notice Minimal decimals read; arbitrary quote tokens may or may not expose it.
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @notice On-chain pricer that values a quote asset for the launchpad.
/// @dev Returns the graduation threshold in the quote asset's own units — the
///      amount of the quote asset a fully sold curve must raise, i.e. roughly
///      `GRADUATION_ETH` worth. Zero means "cannot price / not eligible", which
///      the launchpad treats as a refusal. A real implementation walks a route
///      of on-chain pools (our own pools on Ink; Uniswap v4 hops on Robinhood)
///      with a minimum-depth floor. It is deliberately a separate contract so
///      the curve logic here never has to know how a price was found.
interface IPairQuotePricer {
    function graduationQuote(address quoteToken) external view returns (uint256);
}

/// @title UnderwaterPairLaunchpad
/// @notice Sibling of `UnderwaterLaunchpad` for curves quoted in an ERC-20
///         (a tokenized equity, USDG, another token) instead of ETH.
///
/// The curve, the 800M/200M split and the graduation-equals-4x-virtual identity
/// are all identical to the ETH launchpad — only the unit of account changes
/// from ETH to a per-launch `quoteToken`. Because the reserve `x` is now an
/// ERC-20 rather than `msg.value`, every money path moves tokens with
/// `SafeTransferLib` and pulls the quote in through `transferFrom`.
///
/// Two things this contract does that the ETH launchpad does not:
///
///  1. **Per-launch economics.** `x0` (the virtual quote reserve) and the
///     graduation threshold are not constants — they are the quote amount worth
///     ~`GRADUATION_ETH`, decided by an on-chain `pricer` (or an owner override)
///     and *snapshotted into the pool at create*, so a later price move or
///     re-approval cannot re-denominate a live curve.
///
///  2. **A three-way trade-fee split.** The trade fee (in the quote asset) is
///     divided between the protocol, a $WATER buyback-and-burn, and a banked
///     creator treasury the creator can withdraw. The creation and graduation
///     fees stay 100% protocol. See the fee-split section for why the treasury
///     is a real balance rather than a soft points credit.
contract UnderwaterPairLaunchpad is Owned, ReentrancyGuard {
    using SafeTransferLib for address;

    // ─── Curve parameters (shared with the ETH launchpad) ──────────────────

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    uint256 public constant LP_SUPPLY = 200_000_000e18;

    /// @notice Starting token-side reserve (the `y0` term), equal to TOTAL_SUPPLY.
    uint256 public constant INITIAL_TOKEN_RESERVE = 1_000_000_000e18;

    /// @notice Graduation raise as a multiple of the virtual quote reserve.
    /// @dev The curve makes `raise(CURVE_SUPPLY) = 4 * x0` exactly (same algebra
    ///      as the ETH curve), so a launch stores `graduationQuote` and derives
    ///      `x0 = graduationQuote / GRADUATION_MULTIPLE`. Keeping the identity
    ///      instead of storing both numbers is what stops them drifting apart.
    uint256 public constant GRADUATION_MULTIPLE = 4;

    // ─── Fee bounds ────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_TRADE_FEE_BPS = 200; // 2%
    uint256 public constant MAX_GRADUATION_FEE_BPS = 1_000; // 10%
    uint256 public constant MAX_CREATION_FEE = 0.01 ether;

    address public constant LP_BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Gas that must remain before the liquidity deposit is attempted.
    /// @dev Same rationale as the ETH launchpad: keeps `eth_estimateGas` honest
    ///      so a wallet cannot settle on the limit that skips graduation.
    uint256 public constant GRADUATION_GAS_RESERVE = 3_000_000;

    // ─── State ─────────────────────────────────────────────────────────────

    /// @param quoteToken    ERC-20 this curve is priced in. Frozen at create.
    /// @param quoteReserve  Virtual + real quote on the curve (the `x` term).
    /// @param tokenReserve  Virtual token reserve remaining (the `y` term).
    /// @param realQuoteRaised Real quote held for this pool, net of trade fees.
    /// @param graduationQuote Quote that must accumulate before graduation.
    /// @param tokensSold    Curve tokens released to buyers so far.
    /// @param creator       Address that launched the token.
    /// @param createdAt     Launch timestamp.
    /// @param graduated     True once liquidity has moved to the DEX.
    /// @param exists        Distinguishes an unset entry from a real pool.
    struct Pool {
        address quoteToken;
        uint128 quoteReserve;
        uint128 tokenReserve;
        uint128 realQuoteRaised;
        uint128 graduationQuote;
        uint128 tokensSold;
        address creator;
        uint40 createdAt;
        bool graduated;
        bool exists;
    }

    mapping(address token => Pool) public pools;

    /// @notice Every token ever launched, in creation order.
    address[] public allTokens;

    /// @notice Quote held for live curves, per quote token. Any balance beyond
    ///         this plus the treasury and buyback reserves is sweepable dust.
    mapping(address quoteToken => uint256) public totalCurveQuote;

    /// @notice Banked creator earnings, per creator per quote token. This is a
    ///         real, withdrawable balance — see the fee-split notes.
    mapping(address creator => mapping(address quoteToken => uint256)) public creatorTreasury;

    /// @notice Sum of `creatorTreasury` across creators, per quote token.
    mapping(address quoteToken => uint256) public creatorTreasuryTotal;

    /// @notice Quote accrued for $WATER buyback-and-burn, per quote token.
    mapping(address quoteToken => uint256) public buybackReserve;

    /// @notice Owner-set economics that take priority over the pricer. Zero
    ///         means "ask the pricer". This is the testnet path (no deep pools
    ///         exist there to price against) and the mainnet escape hatch.
    mapping(address quoteToken => uint256) public graduationQuoteOverride;

    IUnderwaterRouter public router;
    IPairQuotePricer public pricer;
    address public feeRecipient;

    /// @notice $WATER token bought and burned by the buyback bucket. Zero until
    ///         $WATER is live; while zero, the buyback share only accrues.
    address public waterToken;

    uint256 public tradeFeeBps;
    uint256 public creationFee; // paid in ETH via msg.value
    uint256 public graduationFeeBps;

    /// @notice Three-way split of the *trade* fee, in bps of the fee. Must sum
    ///         to BPS_DENOMINATOR. Creation and graduation fees are unaffected.
    uint256 public protocolShareBps;
    uint256 public burnShareBps;
    uint256 public creatorShareBps;

    // ─── Events ────────────────────────────────────────────────────────────

    event PairTokenCreated(
        address indexed token,
        address indexed creator,
        address indexed quoteToken,
        string name,
        string symbol,
        string metadataURI,
        uint256 graduationQuote,
        uint256 timestamp
    );

    /// @dev Reserves are included so an indexer can derive price and market cap
    ///      from the log alone. Fee is split three ways in the same event so the
    ///      points indexer can credit the creator treasury without a second read.
    event PairTrade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 quoteAmount,
        uint256 tokenAmount,
        uint256 protocolFee,
        uint256 burnFee,
        uint256 creatorFee,
        uint128 quoteReserve,
        uint128 tokenReserve,
        uint128 realQuoteRaised,
        uint256 timestamp
    );

    /// @notice The creator's banked balance grew. This is the event uwPoints
    ///         reads to show creator earnings as "points like cash".
    event CreatorTreasuryAccrued(
        address indexed token,
        address indexed creator,
        address indexed quoteToken,
        uint256 amount,
        uint256 timestamp
    );

    event CreatorTreasuryClaimed(
        address indexed creator, address indexed quoteToken, address to, uint256 amount
    );

    event BuybackAndBurned(
        address indexed quoteToken, uint256 quoteIn, uint256 waterBurned, address indexed caller
    );

    event PairGraduated(
        address indexed token,
        address indexed pair,
        address indexed quoteToken,
        uint256 quoteLiquidity,
        uint256 tokenLiquidity,
        uint256 graduationFee,
        uint256 timestamp
    );

    event GraduationFailed(address indexed token, uint256 raised);

    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event PricerUpdated(address indexed oldPricer, address indexed newPricer);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event WaterTokenUpdated(address indexed oldWater, address indexed newWater);
    event TradeFeeUpdated(uint256 oldBps, uint256 newBps);
    event CreationFeeUpdated(uint256 oldFee, uint256 newFee);
    event GraduationFeeUpdated(uint256 oldBps, uint256 newBps);
    event FeeSplitUpdated(uint256 protocolBps, uint256 burnBps, uint256 creatorBps);
    event PairTokenEconomicsUpdated(address indexed quoteToken, uint256 graduationQuote);
    event Swept(address indexed quoteToken, address indexed to, uint256 amount);

    // ─── Errors ────────────────────────────────────────────────────────────

    error UnknownToken();
    error AlreadyGraduated();
    error NotGraduated();
    error FeeTooHigh();
    error BadFeeSplit();
    error EmptyMetadata();
    error InsufficientCreationFee();
    error SlippageExceeded(uint256 got, uint256 minimum);
    error ZeroAmount();
    error InsufficientBalance();
    error ValueOverflow();
    error NothingToSweep();
    error QuoteNotApproved();
    error QuoteNotEighteenDecimals();
    error InexactTransfer();
    error WaterNotLive();
    error BadPath();
    error GraduationOutOfGas();

    // ─── Construction ──────────────────────────────────────────────────────

    constructor(
        address _owner,
        address _router,
        address _feeRecipient,
        uint256 _tradeFeeBps,
        uint256 _creationFee,
        uint256 _graduationFeeBps,
        uint256 _protocolShareBps,
        uint256 _burnShareBps,
        uint256 _creatorShareBps
    ) Owned(_owner) {
        if (_router == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        if (
            _tradeFeeBps > MAX_TRADE_FEE_BPS || _creationFee > MAX_CREATION_FEE
                || _graduationFeeBps > MAX_GRADUATION_FEE_BPS
        ) revert FeeTooHigh();
        if (_protocolShareBps + _burnShareBps + _creatorShareBps != BPS_DENOMINATOR) {
            revert BadFeeSplit();
        }

        router = IUnderwaterRouter(_router);
        feeRecipient = _feeRecipient;
        tradeFeeBps = _tradeFeeBps;
        creationFee = _creationFee;
        graduationFeeBps = _graduationFeeBps;
        protocolShareBps = _protocolShareBps;
        burnShareBps = _burnShareBps;
        creatorShareBps = _creatorShareBps;
    }

    /// @dev The router refunds unused quote to this contract as tokens, not ETH,
    ///      so no ETH is expected here beyond the creation fee handled in `create`.
    receive() external payable {}

    // ─── Launch ────────────────────────────────────────────────────────────

    /// @notice Deploy a token and open its bonding curve, quoted in `quoteToken`.
    /// @dev `msg.value` pays the flat `creationFee` in ETH. The optional initial
    ///      buy is in the quote asset: approve `quoteBuyIn` of `quoteToken` to
    ///      this contract first. Buying in the same transaction is the only way
    ///      to be first, which removes the incentive to snipe your own launch.
    /// @param name Token name.
    /// @param symbol Token symbol.
    /// @param metadataURI Pointer to off-chain metadata.
    /// @param quoteToken ERC-20 the curve is priced in (must be 18 decimals).
    /// @param quoteBuyIn Optional initial buy amount, in the quote asset.
    /// @param minTokensOut Slippage bound for the optional initial buy.
    function create(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        address quoteToken,
        uint256 quoteBuyIn,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token) {
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyMetadata();
        if (msg.value < creationFee) revert InsufficientCreationFee();
        if (quoteToken == address(0)) revert ZeroAddress();
        if (IERC20Decimals(quoteToken).decimals() != 18) revert QuoteNotEighteenDecimals();

        // Snapshot the economics now so nothing that happens to the quote asset
        // later can re-denominate this curve.
        uint256 resolved = _resolveGraduationQuote(quoteToken);
        if (resolved < GRADUATION_MULTIPLE) revert QuoteNotApproved();
        // Re-derive the threshold as an exact multiple of the virtual reserve so
        // the token-side exhaustion (all CURVE_SUPPLY sold) and the quote-side
        // threshold coincide to the wei. Without this, integer truncation could
        // leave a fully sold curve a few wei short of graduating. The dust
        // dropped here is at most 3 wei of an 18-decimal quote.
        uint256 virtualQuote = resolved / GRADUATION_MULTIPLE;
        uint256 gradQuote = virtualQuote * GRADUATION_MULTIPLE;

        token = address(new MemeToken(name, symbol, metadataURI, msg.sender, TOTAL_SUPPLY));

        pools[token] = Pool({
            quoteToken: quoteToken,
            quoteReserve: _toU128(virtualQuote),
            tokenReserve: _toU128(INITIAL_TOKEN_RESERVE),
            realQuoteRaised: 0,
            graduationQuote: _toU128(gradQuote),
            tokensSold: 0,
            creator: msg.sender,
            createdAt: uint40(block.timestamp),
            graduated: false,
            exists: true
        });
        allTokens.push(token);

        _emitCreated(token, quoteToken, name, symbol, metadataURI, gradQuote);

        uint256 fee = creationFee;
        if (fee > 0) SafeTransferLib.safeTransferETH(feeRecipient, fee);
        // Any ETH beyond the creation fee is refunded — the curve takes quote,
        // not ETH, so there is nothing else to spend it on.
        uint256 ethRefund = msg.value - fee;
        if (ethRefund > 0) SafeTransferLib.safeTransferETH(msg.sender, ethRefund);

        if (quoteBuyIn > 0) {
            _buy(token, msg.sender, quoteBuyIn, minTokensOut, msg.sender);
        } else if (minTokensOut > 0) {
            revert SlippageExceeded(0, minTokensOut);
        }
    }

    /// @dev Isolated so the eight-field event with three string args does not
    ///      blow `create`'s stack.
    function _emitCreated(
        address token,
        address quoteToken,
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 gradQuote
    ) internal {
        emit PairTokenCreated(
            token, msg.sender, quoteToken, name, symbol, metadataURI, gradQuote, block.timestamp
        );
    }

    // ─── Trading ───────────────────────────────────────────────────────────

    /// @notice Buy tokens from the curve by paying `quoteIn` of the quote asset.
    /// @dev Requires an ERC20 approval to this contract for `quoteIn`.
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, address to)
        external
        nonReentrant
        returns (uint256 tokensBought)
    {
        if (to == address(0)) revert ZeroAddress();
        if (quoteIn == 0) revert ZeroAmount();
        return _buy(token, msg.sender, quoteIn, minTokensOut, to);
    }

    /// @notice Sell tokens back into the curve for the quote asset.
    /// @dev Requires an ERC20 approval to this contract for `tokenAmount`.
    function sell(address token, uint256 tokenAmount, uint256 minQuoteOut, address to)
        external
        nonReentrant
        returns (uint256 quoteReceived)
    {
        if (to == address(0)) revert ZeroAddress();
        if (tokenAmount == 0) revert ZeroAmount();

        Pool storage p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();
        if (tokenAmount > p.tokensSold) revert InsufficientBalance();

        uint256 grossQuote = CurveMath.ethOut(p.quoteReserve, p.tokenReserve, tokenAmount);
        // Defensive: the curve rounds in the pool's favour, so a sale can never
        // exceed the real quote that funded it.
        if (grossQuote > p.realQuoteRaised) revert InsufficientBalance();

        uint256 fee = (grossQuote * tradeFeeBps) / BPS_DENOMINATOR;
        quoteReceived = grossQuote - fee;
        if (quoteReceived < minQuoteOut) revert SlippageExceeded(quoteReceived, minQuoteOut);

        address quoteToken = p.quoteToken;

        // State first, external calls after.
        p.quoteReserve -= _toU128(grossQuote);
        p.tokenReserve += _toU128(tokenAmount);
        p.realQuoteRaised -= _toU128(grossQuote);
        p.tokensSold -= _toU128(tokenAmount);
        totalCurveQuote[quoteToken] -= grossQuote;

        // Pull the tokens being sold in, then settle fees and pay out. MemeToken
        // has no hooks, so it cannot re-enter.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        MemeToken(token).transferFrom(msg.sender, address(this), tokenAmount);

        _settleTrade(token, msg.sender, false, grossQuote, tokenAmount, fee, quoteToken);
        quoteToken.safeTransfer(to, quoteReceived);
    }

    /// @dev Shared buy path. Pulls `quoteIn` from `payer`, exact-transfer checked
    ///      so fee-on-transfer and rebasing quotes are rejected rather than
    ///      silently under-crediting the curve.
    function _buy(address token, address payer, uint256 quoteIn, uint256 minTokensOut, address to)
        internal
        returns (uint256 tokensBought)
    {
        Pool storage p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();

        address quoteToken = p.quoteToken;

        // Pull first and measure what actually arrived. Anything other than an
        // exact transfer (fee-on-transfer, rebasing) breaks the curve's exact
        // accounting, so refuse it here.
        uint256 balBefore = IERC20Minimal(quoteToken).balanceOf(address(this));
        quoteToken.safeTransferFrom(payer, address(this), quoteIn);
        uint256 received = IERC20Minimal(quoteToken).balanceOf(address(this)) - balBefore;
        if (received != quoteIn) revert InexactTransfer();

        uint256 fee = (quoteIn * tradeFeeBps) / BPS_DENOMINATOR;
        uint256 quoteNet = quoteIn - fee;
        uint256 refund;

        // Never let a buy overshoot the graduation threshold: size it down to
        // land exactly on it and refund the rest.
        uint256 remaining = uint256(p.graduationQuote) - p.realQuoteRaised;
        if (quoteNet > remaining) {
            quoteNet = remaining;
            uint256 grossNeeded = _mulDivUp(remaining, BPS_DENOMINATOR, BPS_DENOMINATOR - tradeFeeBps);
            if (grossNeeded > quoteIn) grossNeeded = quoteIn;
            fee = grossNeeded - quoteNet;
            refund = quoteIn - grossNeeded;
        }

        tokensBought = CurveMath.tokensOut(p.quoteReserve, p.tokenReserve, quoteNet);

        uint256 tokensLeft = CURVE_SUPPLY - p.tokensSold;
        if (tokensBought > tokensLeft) tokensBought = tokensLeft;

        if (tokensBought < minTokensOut) revert SlippageExceeded(tokensBought, minTokensOut);
        if (tokensBought == 0) revert ZeroAmount();

        p.quoteReserve += _toU128(quoteNet);
        p.tokenReserve -= _toU128(tokensBought);
        p.realQuoteRaised += _toU128(quoteNet);
        p.tokensSold += _toU128(tokensBought);
        totalCurveQuote[quoteToken] += quoteNet;

        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        MemeToken(token).transfer(to, tokensBought);

        _settleTrade(token, payer, true, quoteNet, tokensBought, fee, quoteToken);
        if (refund > 0) quoteToken.safeTransfer(payer, refund);

        if (p.realQuoteRaised >= p.graduationQuote) _graduate(token);
    }

    /// @dev Split the fee, bank the creator + buyback parts, emit the trade with
    ///      post-trade reserves, and pay the protocol its cut. Kept as its own
    ///      frame so the twelve-field event does not blow the caller's stack.
    function _settleTrade(
        address token,
        address trader,
        bool isBuy,
        uint256 quoteAmount,
        uint256 tokenAmount,
        uint256 fee,
        address quoteToken
    ) internal {
        Pool storage p = pools[token];
        (uint256 protocolFee, uint256 burnFee, uint256 creatorFee) =
            _splitAndAccrue(token, p.creator, quoteToken, fee);

        emit PairTrade(
            token,
            trader,
            isBuy,
            quoteAmount,
            tokenAmount,
            protocolFee,
            burnFee,
            creatorFee,
            p.quoteReserve,
            p.tokenReserve,
            p.realQuoteRaised,
            block.timestamp
        );

        if (protocolFee > 0) quoteToken.safeTransfer(feeRecipient, protocolFee);
    }

    /// @dev Split a trade fee three ways and bank the creator + buyback parts.
    ///      Protocol part is returned for the caller to transfer out after its
    ///      own state writes. The creator part becomes a withdrawable balance;
    ///      the burn part waits in the buyback reserve for `buybackAndBurn`.
    function _splitAndAccrue(address token, address creator, address quoteToken, uint256 fee)
        internal
        returns (uint256 protocolFee, uint256 burnFee, uint256 creatorFee)
    {
        if (fee == 0) return (0, 0, 0);
        // Creator gets the residual so the three parts always re-sum to `fee`
        // with no rounding dust left unassigned.
        protocolFee = (fee * protocolShareBps) / BPS_DENOMINATOR;
        burnFee = (fee * burnShareBps) / BPS_DENOMINATOR;
        creatorFee = fee - protocolFee - burnFee;

        if (burnFee > 0) buybackReserve[quoteToken] += burnFee;
        if (creatorFee > 0) {
            creatorTreasury[creator][quoteToken] += creatorFee;
            creatorTreasuryTotal[quoteToken] += creatorFee;
            emit CreatorTreasuryAccrued(token, creator, quoteToken, creatorFee, block.timestamp);
        }
    }

    // ─── Graduation ────────────────────────────────────────────────────────

    /// @notice Force graduation for a curve that has met the threshold.
    function graduate(address token) external nonReentrant {
        Pool storage p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();
        if (p.realQuoteRaised < p.graduationQuote) revert NotGraduated();
        _graduate(token);
    }

    function _graduate(address token) internal {
        Pool storage p = pools[token];

        if (gasleft() < GRADUATION_GAS_RESERVE) revert GraduationOutOfGas();

        address quoteToken = p.quoteToken;
        uint256 raised = p.realQuoteRaised;
        uint256 graduationFee = (raised * graduationFeeBps) / BPS_DENOMINATOR;
        uint256 quoteLiquidity = raised - graduationFee;
        uint256 unsold = CURVE_SUPPLY - p.tokensSold;

        MemeToken(token).approve(address(router), LP_SUPPLY);
        quoteToken.safeApprove(address(router), quoteLiquidity);

        // Minimums are zero for the same reason as the ETH launchpad: a pair
        // front-run and seeded at a skewed ratio must not be able to strand the
        // raise. The try/catch plus the gas floor above mean reaching `catch`
        // is the router declining on its own terms, not running out of room.
        try router.addLiquidity(
            token, quoteToken, LP_SUPPLY, quoteLiquidity, 0, 0, LP_BURN_ADDRESS, block.timestamp
        ) returns (uint256 tokenUsed, uint256 quoteUsed, uint256) {
            p.graduated = true;
            p.realQuoteRaised = 0;
            totalCurveQuote[quoteToken] -= raised;

            MemeToken(token).approve(address(router), 0);
            quoteToken.safeApprove(address(router), 0);

            if (unsold > 0) MemeToken(token).burn(unsold);
            if (tokenUsed < LP_SUPPLY) MemeToken(token).burn(LP_SUPPLY - tokenUsed);

            address pair = IUnderwaterFactory(router.factory()).getPair(token, quoteToken);
            emit PairGraduated(
                token, pair, quoteToken, quoteUsed, tokenUsed, graduationFee, block.timestamp
            );

            // Protocol cut plus any quote the router refunded.
            uint256 payout = graduationFee + (quoteLiquidity - quoteUsed);
            if (payout > 0) quoteToken.safeTransfer(feeRecipient, payout);
        } catch {
            MemeToken(token).approve(address(router), 0);
            quoteToken.safeApprove(address(router), 0);
            emit GraduationFailed(token, raised);
        }
    }

    // ─── Creator treasury ──────────────────────────────────────────────────

    /// @notice Withdraw your banked creator earnings in a given quote asset.
    /// @dev This is the "points like cash" balance: real quote tokens the
    ///      creator earned from trading on their launch, claimable any time.
    function claimTreasury(address quoteToken, address to)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (to == address(0)) revert ZeroAddress();
        amount = creatorTreasury[msg.sender][quoteToken];
        if (amount == 0) revert NothingToSweep();

        creatorTreasury[msg.sender][quoteToken] = 0;
        creatorTreasuryTotal[quoteToken] -= amount;

        emit CreatorTreasuryClaimed(msg.sender, quoteToken, to, amount);
        quoteToken.safeTransfer(to, amount);
    }

    // ─── Buyback & burn ────────────────────────────────────────────────────

    /// @notice Spend the accrued buyback reserve of `quoteToken` on $WATER and
    ///         burn it. Permissionless — a keeper runs it; anyone may.
    /// @dev Dormant until `waterToken` is set: until then the burn share simply
    ///      accrues in `buybackReserve` and is never touched. `path` is supplied
    ///      by the caller (routes differ per quote asset) but is constrained to
    ///      start at `quoteToken` and end at `waterToken`.
    function buybackAndBurn(address quoteToken, uint256 minWaterOut, address[] calldata path)
        external
        nonReentrant
        returns (uint256 waterBurned)
    {
        address water = waterToken;
        if (water == address(0)) revert WaterNotLive();
        uint256 amountIn = buybackReserve[quoteToken];
        if (amountIn == 0) revert NothingToSweep();
        if (path.length < 2 || path[0] != quoteToken || path[path.length - 1] != water) {
            revert BadPath();
        }

        buybackReserve[quoteToken] = 0;
        quoteToken.safeApprove(address(router), amountIn);

        uint256 balBefore = IERC20Minimal(water).balanceOf(address(this));
        router.swapExactTokensForTokens(amountIn, minWaterOut, path, address(this), block.timestamp);
        waterBurned = IERC20Minimal(water).balanceOf(address(this)) - balBefore;

        // Burn by sending to the conventional sink; $WATER need not expose burn.
        water.safeTransfer(LP_BURN_ADDRESS, waterBurned);
        emit BuybackAndBurned(quoteToken, amountIn, waterBurned, msg.sender);
    }

    // ─── Economics resolution ──────────────────────────────────────────────

    /// @dev Owner override wins; otherwise ask the pricer if one is set. Zero
    ///      from both means the asset is not eligible.
    function _resolveGraduationQuote(address quoteToken) internal view returns (uint256) {
        uint256 over = graduationQuoteOverride[quoteToken];
        if (over > 0) return over;
        if (address(pricer) != address(0)) return pricer.graduationQuote(quoteToken);
        return 0;
    }

    /// @notice What graduation threshold a new launch in `quoteToken` would get.
    function previewGraduationQuote(address quoteToken) external view returns (uint256) {
        return _resolveGraduationQuote(quoteToken);
    }

    // ─── Views ─────────────────────────────────────────────────────────────

    /// @notice Tokens received and fee charged for a given quote input.
    function quoteBuy(address token, uint256 quoteIn)
        external
        view
        returns (uint256 tokensOut, uint256 fee, uint256 refund)
    {
        Pool memory p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();

        fee = (quoteIn * tradeFeeBps) / BPS_DENOMINATOR;
        uint256 quoteNet = quoteIn - fee;

        uint256 remaining = uint256(p.graduationQuote) - p.realQuoteRaised;
        if (quoteNet > remaining) {
            quoteNet = remaining;
            uint256 grossNeeded = _mulDivUp(remaining, BPS_DENOMINATOR, BPS_DENOMINATOR - tradeFeeBps);
            if (grossNeeded > quoteIn) grossNeeded = quoteIn;
            fee = grossNeeded - quoteNet;
            refund = quoteIn - grossNeeded;
        }

        tokensOut = CurveMath.tokensOut(p.quoteReserve, p.tokenReserve, quoteNet);
        uint256 tokensLeft = CURVE_SUPPLY - p.tokensSold;
        if (tokensOut > tokensLeft) tokensOut = tokensLeft;
    }

    /// @notice Quote received and fee charged for selling `tokenAmount`.
    function quoteSell(address token, uint256 tokenAmount)
        external
        view
        returns (uint256 quoteOut, uint256 fee)
    {
        Pool memory p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();

        uint256 grossQuote = CurveMath.ethOut(p.quoteReserve, p.tokenReserve, tokenAmount);
        fee = (grossQuote * tradeFeeBps) / BPS_DENOMINATOR;
        quoteOut = grossQuote - fee;
    }

    /// @notice Marginal price in quote units per whole token, scaled by 1e18.
    function spotPriceE18(address token) external view returns (uint256) {
        Pool memory p = pools[token];
        if (!p.exists) revert UnknownToken();
        return CurveMath.spotPriceE18(p.quoteReserve, p.tokenReserve);
    }

    /// @notice Progress toward graduation in basis points (10000 = ready).
    function progressBps(address token) external view returns (uint256) {
        Pool memory p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) return BPS_DENOMINATOR;
        return (uint256(p.realQuoteRaised) * BPS_DENOMINATOR) / p.graduationQuote;
    }

    /// @notice Fully diluted valuation in quote units, at the marginal price.
    function marketCapQuote(address token) external view returns (uint256) {
        Pool memory p = pools[token];
        if (!p.exists) revert UnknownToken();
        return (CurveMath.spotPriceE18(p.quoteReserve, p.tokenReserve) * TOTAL_SUPPLY) / 1e18;
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    function tokensSlice(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 total = allTokens.length;
        if (start >= total) return new address[](0);
        uint256 end = start + count;
        if (end > total) end = total;
        page = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = allTokens[i];
        }
    }

    // ─── Admin ─────────────────────────────────────────────────────────────

    function setRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert ZeroAddress();
        emit RouterUpdated(address(router), newRouter);
        router = IUnderwaterRouter(newRouter);
    }

    function setPricer(address newPricer) external onlyOwner {
        emit PricerUpdated(address(pricer), newPricer);
        pricer = IPairQuotePricer(newPricer);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /// @notice Set the $WATER token the buyback bucket buys and burns. Setting
    ///         it non-zero switches the buyback on; it can only be set once the
    ///         token and a route to it exist.
    function setWaterToken(address newWater) external onlyOwner {
        emit WaterTokenUpdated(waterToken, newWater);
        waterToken = newWater;
    }

    function setTradeFeeBps(uint256 newBps) external onlyOwner {
        if (newBps > MAX_TRADE_FEE_BPS) revert FeeTooHigh();
        emit TradeFeeUpdated(tradeFeeBps, newBps);
        tradeFeeBps = newBps;
    }

    function setCreationFee(uint256 newFee) external onlyOwner {
        if (newFee > MAX_CREATION_FEE) revert FeeTooHigh();
        emit CreationFeeUpdated(creationFee, newFee);
        creationFee = newFee;
    }

    function setGraduationFeeBps(uint256 newBps) external onlyOwner {
        if (newBps > MAX_GRADUATION_FEE_BPS) revert FeeTooHigh();
        emit GraduationFeeUpdated(graduationFeeBps, newBps);
        graduationFeeBps = newBps;
    }

    /// @notice Set the three-way split of the trade fee. Must sum to 10000.
    function setFeeSplit(uint256 protocolBps, uint256 burnBps, uint256 creatorBps)
        external
        onlyOwner
    {
        if (protocolBps + burnBps + creatorBps != BPS_DENOMINATOR) revert BadFeeSplit();
        protocolShareBps = protocolBps;
        burnShareBps = burnBps;
        creatorShareBps = creatorBps;
        emit FeeSplitUpdated(protocolBps, burnBps, creatorBps);
    }

    /// @notice Curated economics for a quote asset, overriding the pricer. Zero
    ///         clears the override (falls back to the pricer). This is how the
    ///         testnet mocks are priced and the mainnet escape hatch.
    function setPairTokenEconomics(address quoteToken, uint256 gradQuote) external onlyOwner {
        if (quoteToken == address(0)) revert ZeroAddress();
        if (gradQuote != 0 && gradQuote < GRADUATION_MULTIPLE) revert QuoteNotApproved();
        graduationQuoteOverride[quoteToken] = gradQuote;
        emit PairTokenEconomicsUpdated(quoteToken, gradQuote);
    }

    /// @notice Recover quote tokens that are not backing any live curve, any
    ///         creator's treasury, or a pending buyback.
    function sweep(address quoteToken, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 reserved =
            totalCurveQuote[quoteToken] + creatorTreasuryTotal[quoteToken] + buybackReserve[quoteToken];
        uint256 balance = IERC20Minimal(quoteToken).balanceOf(address(this));
        uint256 excess = balance - reserved;
        if (excess == 0) revert NothingToSweep();
        emit Swept(quoteToken, to, excess);
        quoteToken.safeTransfer(to, excess);
    }

    // ─── Internal helpers ──────────────────────────────────────────────────

    function _toU128(uint256 value) internal pure returns (uint128) {
        if (value > type(uint128).max) revert ValueOverflow();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(value);
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        uint256 product = a * b;
        uint256 quotient = product / d;
        return quotient * d == product ? quotient : quotient + 1;
    }
}
