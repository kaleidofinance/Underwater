// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUniswapV2Factory, IUniswapV2Router02} from "./interfaces/IUniswapV2.sol";
import {CurveMath} from "./lib/CurveMath.sol";
import {MemeToken} from "./token/MemeToken.sol";
import {Owned} from "./utils/Owned.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";

/// @title UnderwaterLaunchpad
/// @notice Permissionless meme token launchpad for Ink.
///
/// Lifecycle of a launch:
///
///  1. Anyone calls `create`, which deploys a fixed-supply `MemeToken` and
///     opens a bonding curve seeded with virtual reserves. No liquidity is
///     required from the creator.
///  2. Traders `buy` and `sell` against the curve. Every trade pays
///     `tradeFeeBps` on the ETH leg to `feeRecipient`.
///  3. Once `GRADUATION_ETH` of real ETH has accumulated, the curve closes
///     permanently and the contract deposits `LP_SUPPLY` tokens plus the
///     raised ETH into a Uniswap-V2-style pool, sending the LP tokens to a
///     burn address so the liquidity can never be withdrawn by anyone.
///
/// Curve parameters are chosen so the two exit conditions coincide exactly:
/// selling all 800M curve tokens raises precisely 4 ETH of net proceeds.
///
///     tokensOut(dx) = y*dx/(x+dx)     with x0 = 1e18, y0 = 1e27
///     raise(S) = x0 * S / (y0 - S) = 1e18 * 8e26 / 2e26 = 4e18
///
/// which is why the virtual token floor (y0 - CURVE_SUPPLY = 200M) equals the
/// LP allocation. Start-to-graduation is a ~25x move in marginal price.
contract UnderwaterLaunchpad is Owned, ReentrancyGuard {
    // ─── Curve parameters (immutable by construction) ─────────────────────

    /// @notice Full supply minted per launch: 1,000,000,000 tokens.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @notice Portion sellable on the bonding curve: 800,000,000 tokens.
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;

    /// @notice Portion held back to seed the DEX pool: 200,000,000 tokens.
    uint256 public constant LP_SUPPLY = 200_000_000e18;

    /// @notice Virtual ETH that seeds the curve. Never withdrawable — it only
    ///         exists to give the first buyer a finite entry price.
    uint256 public constant VIRTUAL_ETH_RESERVE = 1 ether;

    /// @notice Starting token-side reserve, virtual and equal to TOTAL_SUPPLY.
    uint256 public constant INITIAL_TOKEN_RESERVE = 1_000_000_000e18;

    /// @notice Net ETH that must accumulate on a curve before it graduates.
    uint256 public constant GRADUATION_ETH = 4 ether;

    // ─── Fee bounds ───────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard ceiling on the trade fee: 2%. The owner cannot exceed it.
    uint256 public constant MAX_TRADE_FEE_BPS = 200;

    /// @notice Hard ceiling on the protocol's cut of a graduation raise: 10%.
    uint256 public constant MAX_GRADUATION_FEE_BPS = 1_000;

    /// @notice Hard ceiling on the flat creation fee, so the owner can never
    ///         price launches out of reach.
    uint256 public constant MAX_CREATION_FEE = 0.01 ether;

    /// @dev LP tokens are sent here at graduation. address(0) is rejected by
    ///      most V2 pairs, so use the conventional burn sink instead.
    address public constant LP_BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Gas that must remain before the liquidity deposit is attempted.
    ///
    /// @dev Not a micro-optimisation — it is what makes gas estimation honest.
    ///      The deposit is wrapped in try/catch so a hostile router cannot brick
    ///      the final buy, which means a deposit that merely runs out of gas
    ///      leaves the *transaction* successful. `eth_estimateGas` binary
    ///      searches for the cheapest gas limit that does not revert, so without
    ///      this floor every wallet-estimated final buy would settle on the limit
    ///      that skips the deposit and parks the curve at the threshold instead
    ///      of graduating it.
    ///
    ///      Reverting below the floor forces the estimate upward until the
    ///      deposit provably fits. Seeding a fresh pair on our own DEX measures
    ///      around 2.2M gas, so this leaves roughly 40% headroom for a different
    ///      router or a future repricing.
    uint256 public constant GRADUATION_GAS_RESERVE = 3_000_000;

    // ─── State ────────────────────────────────────────────────────────────

    /// @param ethReserve     Virtual + real ETH on the curve (the `x` term).
    /// @param tokenReserve   Virtual token reserve remaining (the `y` term).
    /// @param realEthRaised  Real ETH actually held for this pool, net of fees.
    /// @param tokensSold     Curve tokens released to buyers so far.
    /// @param creator        Address that launched the token.
    /// @param createdAt      Launch timestamp.
    /// @param graduated      True once liquidity has moved to the DEX.
    /// @param exists         Distinguishes an unset mapping entry from a pool.
    struct Pool {
        uint128 ethReserve;
        uint128 tokenReserve;
        uint128 realEthRaised;
        uint128 tokensSold;
        address creator;
        uint40 createdAt;
        bool graduated;
        bool exists;
    }

    mapping(address token => Pool) public pools;

    /// @notice Every token ever launched, in creation order.
    address[] public allTokens;

    /// @notice Sum of `realEthRaised` across all live curves. Any balance
    ///         beyond this is unaccounted dust and is safe to sweep.
    uint256 public totalCurveEth;

    /// @notice Router used to seed liquidity at graduation.
    IUniswapV2Router02 public router;

    /// @notice Recipient of trade fees, creation fees and graduation cuts.
    address public feeRecipient;

    uint256 public tradeFeeBps;
    uint256 public creationFee;
    uint256 public graduationFeeBps;

    // ─── Events ───────────────────────────────────────────────────────────

    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        uint256 timestamp
    );

    /// @dev Reserves are included so an indexer can derive price and market cap
    ///      from the log alone, with no follow-up RPC call per trade.
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 feeAmount,
        uint128 ethReserve,
        uint128 tokenReserve,
        uint128 realEthRaised,
        uint256 timestamp
    );

    event Graduated(
        address indexed token,
        address indexed pair,
        uint256 ethLiquidity,
        uint256 tokenLiquidity,
        uint256 protocolFee,
        uint256 timestamp
    );

    /// @notice Emitted when the liquidity deposit failed and the curve is
    ///         parked at the threshold awaiting a retry via `graduate`.
    event GraduationFailed(address indexed token, uint256 raised);

    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event TradeFeeUpdated(uint256 oldBps, uint256 newBps);
    event CreationFeeUpdated(uint256 oldFee, uint256 newFee);
    event GraduationFeeUpdated(uint256 oldBps, uint256 newBps);
    event Swept(address indexed to, uint256 amount);

    // ─── Errors ───────────────────────────────────────────────────────────

    error UnknownToken();
    error AlreadyGraduated();
    error NotGraduated();
    error FeeTooHigh();
    error EmptyMetadata();
    error InsufficientCreationFee();
    error SlippageExceeded(uint256 got, uint256 minimum);
    error ZeroAmount();
    error InsufficientBalance();
    error EthTransferFailed();
    error ValueOverflow();
    error NothingToSweep();

    /// @dev The liquidity deposit ran out of gas rather than reverting on its
    ///      own terms. Raised so gas estimation is forced to fit the real cost
    ///      instead of settling on the cheaper `GraduationFailed` path.
    error GraduationOutOfGas();

    // ─── Construction ─────────────────────────────────────────────────────

    constructor(
        address _owner,
        address _router,
        address _feeRecipient,
        uint256 _tradeFeeBps,
        uint256 _creationFee,
        uint256 _graduationFeeBps
    ) Owned(_owner) {
        if (_router == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        if (
            _tradeFeeBps > MAX_TRADE_FEE_BPS || _creationFee > MAX_CREATION_FEE
                || _graduationFeeBps > MAX_GRADUATION_FEE_BPS
        ) revert FeeTooHigh();

        router = IUniswapV2Router02(_router);
        feeRecipient = _feeRecipient;
        tradeFeeBps = _tradeFeeBps;
        creationFee = _creationFee;
        graduationFeeBps = _graduationFeeBps;
    }

    /// @dev The V2 router refunds unused ETH to `msg.sender` when the pool
    ///      consumes less than it was sent, so this contract must accept it.
    receive() external payable {}

    // ─── Launch ───────────────────────────────────────────────────────────

    /// @notice Deploy a token and open its bonding curve.
    /// @dev Any `msg.value` beyond `creationFee` is immediately spent as the
    ///      creator's own first buy, in the same transaction. That is the only
    ///      way to be first into a launch, which removes the incentive to race
    ///      your own token with a separate sniping transaction.
    /// @param name Token name.
    /// @param symbol Token symbol.
    /// @param metadataURI Pointer to off-chain metadata (image, socials).
    /// @param minTokensOut Slippage bound for the optional initial buy.
    /// @return token Address of the newly deployed token.
    function create(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token) {
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyMetadata();
        if (msg.value < creationFee) revert InsufficientCreationFee();

        token = address(new MemeToken(name, symbol, metadataURI, msg.sender, TOTAL_SUPPLY));

        pools[token] = Pool({
            ethReserve: _toU128(VIRTUAL_ETH_RESERVE),
            tokenReserve: _toU128(INITIAL_TOKEN_RESERVE),
            realEthRaised: 0,
            tokensSold: 0,
            creator: msg.sender,
            createdAt: uint40(block.timestamp),
            graduated: false,
            exists: true
        });
        allTokens.push(token);

        emit TokenCreated(token, msg.sender, name, symbol, metadataURI, block.timestamp);

        uint256 fee = creationFee;
        if (fee > 0) _sendEth(feeRecipient, fee);

        uint256 initialBuy = msg.value - fee;
        if (initialBuy > 0) {
            _buy(token, initialBuy, minTokensOut, msg.sender);
        } else if (minTokensOut > 0) {
            // Caller asked for tokens but sent nothing to buy them with.
            revert SlippageExceeded(0, minTokensOut);
        }
    }

    // ─── Trading ──────────────────────────────────────────────────────────

    /// @notice Buy tokens from the curve with ETH.
    /// @param token Token to buy.
    /// @param minTokensOut Revert if fewer tokens than this would be received.
    /// @param to Recipient of the tokens.
    /// @return tokensBought Tokens actually delivered.
    function buy(address token, uint256 minTokensOut, address to)
        external
        payable
        nonReentrant
        returns (uint256 tokensBought)
    {
        if (to == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        return _buy(token, msg.value, minTokensOut, to);
    }

    /// @notice Sell tokens back into the curve for ETH.
    /// @dev Requires an ERC20 approval to this contract for `tokenAmount`.
    /// @param token Token to sell.
    /// @param tokenAmount Amount to sell.
    /// @param minEthOut Revert if less ETH than this would be received.
    /// @param to Recipient of the ETH.
    /// @return ethReceived ETH delivered, net of fee.
    function sell(address token, uint256 tokenAmount, uint256 minEthOut, address to)
        external
        nonReentrant
        returns (uint256 ethReceived)
    {
        if (to == address(0)) revert ZeroAddress();
        if (tokenAmount == 0) revert ZeroAmount();

        Pool storage p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();
        if (tokenAmount > p.tokensSold) revert InsufficientBalance();

        uint256 grossEth = CurveMath.ethOut(p.ethReserve, p.tokenReserve, tokenAmount);
        // Defensive: the curve is symmetric and rounds in the pool's favour, so
        // a sale can never exceed the real ETH that funded it.
        if (grossEth > p.realEthRaised) revert InsufficientBalance();

        uint256 fee = (grossEth * tradeFeeBps) / BPS_DENOMINATOR;
        ethReceived = grossEth - fee;
        if (ethReceived < minEthOut) revert SlippageExceeded(ethReceived, minEthOut);

        // State first, external calls after.
        p.ethReserve -= _toU128(grossEth);
        p.tokenReserve += _toU128(tokenAmount);
        p.realEthRaised -= _toU128(grossEth);
        p.tokensSold -= _toU128(tokenAmount);
        totalCurveEth -= grossEth;

        emit Trade(
            token,
            msg.sender,
            false,
            grossEth,
            tokenAmount,
            fee,
            p.ethReserve,
            p.tokenReserve,
            p.realEthRaised,
            block.timestamp
        );

        // MemeToken always returns true or reverts, so there is no silent
        // failure to check for. It also has no transfer hooks, so this call
        // cannot re-enter.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        MemeToken(token).transferFrom(msg.sender, address(this), tokenAmount);

        if (fee > 0) _sendEth(feeRecipient, fee);
        _sendEth(to, ethReceived);
    }

    /// @dev Shared buy path for `buy` and the initial buy inside `create`.
    function _buy(address token, uint256 grossEthIn, uint256 minTokensOut, address to)
        internal
        returns (uint256 tokensBought)
    {
        Pool storage p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();

        uint256 fee = (grossEthIn * tradeFeeBps) / BPS_DENOMINATOR;
        uint256 ethIn = grossEthIn - fee;
        uint256 refund;

        // Never let a buy overshoot the graduation threshold: size it down to
        // land exactly on it and refund the rest, so the last buyer is not
        // silently charged for tokens the curve cannot sell.
        uint256 remainingEth = GRADUATION_ETH - p.realEthRaised;
        if (ethIn > remainingEth) {
            ethIn = remainingEth;
            uint256 grossNeeded = _mulDivUp(remainingEth, BPS_DENOMINATOR, BPS_DENOMINATOR - tradeFeeBps);
            // Defensive clamp: rounding can never make the required gross
            // exceed what was actually sent.
            if (grossNeeded > grossEthIn) grossNeeded = grossEthIn;
            fee = grossNeeded - ethIn;
            refund = grossEthIn - grossNeeded;
        }

        tokensBought = CurveMath.tokensOut(p.ethReserve, p.tokenReserve, ethIn);

        // Second guard on the token side; with the parameters above this binds
        // at the same instant as the ETH threshold.
        uint256 tokensLeft = CURVE_SUPPLY - p.tokensSold;
        if (tokensBought > tokensLeft) tokensBought = tokensLeft;

        if (tokensBought < minTokensOut) revert SlippageExceeded(tokensBought, minTokensOut);
        if (tokensBought == 0) revert ZeroAmount();

        p.ethReserve += _toU128(ethIn);
        p.tokenReserve -= _toU128(tokensBought);
        p.realEthRaised += _toU128(ethIn);
        p.tokensSold += _toU128(tokensBought);
        totalCurveEth += ethIn;

        emit Trade(
            token,
            msg.sender,
            true,
            ethIn,
            tokensBought,
            fee,
            p.ethReserve,
            p.tokenReserve,
            p.realEthRaised,
            block.timestamp
        );

        // MemeToken always returns true or reverts; nothing to check.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        MemeToken(token).transfer(to, tokensBought);

        if (fee > 0) _sendEth(feeRecipient, fee);
        if (refund > 0) _sendEth(msg.sender, refund);

        if (p.realEthRaised >= GRADUATION_ETH) _graduate(token);
    }

    // ─── Graduation ───────────────────────────────────────────────────────

    /// @notice Force graduation for a curve that has met the threshold.
    /// @dev Graduation normally runs automatically inside the final buy. This
    ///      exists only as a recovery hatch in case that inline attempt fails
    ///      (for example a router that reverts transiently), so a fully funded
    ///      curve can never be stranded.
    function graduate(address token) external nonReentrant {
        Pool storage p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();
        if (p.realEthRaised < GRADUATION_ETH) revert NotGraduated();
        _graduate(token);
    }

    function _graduate(address token) internal {
        Pool storage p = pools[token];

        // Before anything else, and before any state moves: refuse to attempt
        // the deposit on a gas budget that cannot complete it. See
        // GRADUATION_GAS_RESERVE — this is what stops a wallet's gas estimate
        // from quietly choosing the "graduation failed" path over the real one.
        if (gasleft() < GRADUATION_GAS_RESERVE) revert GraduationOutOfGas();

        uint256 raised = p.realEthRaised;
        uint256 protocolFee = (raised * graduationFeeBps) / BPS_DENOMINATOR;
        uint256 ethLiquidity = raised - protocolFee;
        uint256 unsold = CURVE_SUPPLY - p.tokensSold;

        MemeToken(token).approve(address(router), LP_SUPPLY);

        // Minimums are zero on purpose. If someone front-ran us by creating the
        // pair and seeding it at a skewed ratio, non-zero minimums would revert
        // and strand the raise forever. Instead the deposit always succeeds and
        // the leftover is swept below. See README, "Pair front-running".
        //
        // The whole deposit is wrapped in try/catch so a router that reverts
        // cannot brick the final buy. On failure nothing is committed: the pool
        // stays un-graduated at the threshold, sells keep working, and anyone
        // can retry via `graduate` once the router is healthy again.
        //
        // Because of the gas floor above, reaching `catch` means the router
        // declined on its own terms rather than simply running out of room.
        try router.addLiquidityETH{value: ethLiquidity}(
            token, LP_SUPPLY, 0, 0, LP_BURN_ADDRESS, block.timestamp
        ) returns (
            uint256 tokenUsed, uint256 ethUsed, uint256
        ) {
            p.graduated = true;
            p.realEthRaised = 0;
            totalCurveEth -= raised;

            MemeToken(token).approve(address(router), 0);

            // Burn what the curve never sold plus whatever the pool declined,
            // so the circulating float matches what holders actually have.
            if (unsold > 0) MemeToken(token).burn(unsold);
            if (tokenUsed < LP_SUPPLY) MemeToken(token).burn(LP_SUPPLY - tokenUsed);

            address pair = IUniswapV2Factory(router.factory()).getPair(token, router.WETH());
            emit Graduated(token, pair, ethUsed, tokenUsed, protocolFee, block.timestamp);

            // Protocol cut plus any ETH the router refunded.
            uint256 payout = protocolFee + (ethLiquidity - ethUsed);
            if (payout > 0) _sendEth(feeRecipient, payout);
        } catch {
            MemeToken(token).approve(address(router), 0);
            emit GraduationFailed(token, raised);
        }
    }

    // ─── Views ────────────────────────────────────────────────────────────

    /// @notice Tokens received and fee charged for a given ETH input.
    /// @dev Mirrors `buy` exactly, including the pre-graduation size-down, so
    ///      the UI can show the true fill and refund before signing.
    function quoteBuy(address token, uint256 grossEthIn)
        external
        view
        returns (uint256 tokensOut, uint256 fee, uint256 refund)
    {
        Pool memory p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();

        fee = (grossEthIn * tradeFeeBps) / BPS_DENOMINATOR;
        uint256 ethIn = grossEthIn - fee;

        uint256 remainingEth = GRADUATION_ETH - p.realEthRaised;
        if (ethIn > remainingEth) {
            ethIn = remainingEth;
            uint256 grossNeeded = _mulDivUp(remainingEth, BPS_DENOMINATOR, BPS_DENOMINATOR - tradeFeeBps);
            if (grossNeeded > grossEthIn) grossNeeded = grossEthIn;
            fee = grossNeeded - ethIn;
            refund = grossEthIn - grossNeeded;
        }

        tokensOut = CurveMath.tokensOut(p.ethReserve, p.tokenReserve, ethIn);
        uint256 tokensLeft = CURVE_SUPPLY - p.tokensSold;
        if (tokensOut > tokensLeft) tokensOut = tokensLeft;
    }

    /// @notice ETH received and fee charged for selling `tokenAmount`.
    function quoteSell(address token, uint256 tokenAmount)
        external
        view
        returns (uint256 ethOut, uint256 fee)
    {
        Pool memory p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();

        uint256 grossEth = CurveMath.ethOut(p.ethReserve, p.tokenReserve, tokenAmount);
        fee = (grossEth * tradeFeeBps) / BPS_DENOMINATOR;
        ethOut = grossEth - fee;
    }

    /// @notice Marginal price in wei per whole token, scaled by 1e18.
    function spotPriceE18(address token) external view returns (uint256) {
        Pool memory p = pools[token];
        if (!p.exists) revert UnknownToken();
        return CurveMath.spotPriceE18(p.ethReserve, p.tokenReserve);
    }

    /// @notice Progress toward graduation in basis points (10000 = ready).
    function progressBps(address token) external view returns (uint256) {
        Pool memory p = pools[token];
        if (!p.exists) revert UnknownToken();
        if (p.graduated) return BPS_DENOMINATOR;
        return (uint256(p.realEthRaised) * BPS_DENOMINATOR) / GRADUATION_ETH;
    }

    /// @notice Fully diluted valuation in wei, at the current marginal price.
    function marketCapEth(address token) external view returns (uint256) {
        Pool memory p = pools[token];
        if (!p.exists) revert UnknownToken();
        return (CurveMath.spotPriceE18(p.ethReserve, p.tokenReserve) * TOTAL_SUPPLY) / 1e18;
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Paginated token list, newest-last, for indexer backfills.
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

    // ─── Admin ────────────────────────────────────────────────────────────

    /// @dev Changing the router only affects curves that have not graduated
    ///      yet; already-burned LP is untouchable. This is a real trust
    ///      assumption and is documented in the README.
    function setRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert ZeroAddress();
        emit RouterUpdated(address(router), newRouter);
        router = IUniswapV2Router02(newRouter);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
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

    /// @notice Recover ETH that is not backing any live curve.
    /// @dev Bounded by `totalCurveEth`, so trader funds can never be swept.
    function sweep(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 excess = address(this).balance - totalCurveEth;
        if (excess == 0) revert NothingToSweep();
        emit Swept(to, excess);
        _sendEth(to, excess);
    }

    // ─── Internal helpers ─────────────────────────────────────────────────

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    function _toU128(uint256 value) internal pure returns (uint128) {
        if (value > type(uint128).max) revert ValueOverflow();
        // Bounds are checked on the line above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(value);
    }

    /// @dev Ceiling division of `a * b / d`, used so fees round up.
    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        uint256 product = a * b;
        uint256 quotient = product / d;
        return quotient * d == product ? quotient : quotient + 1;
    }
}
