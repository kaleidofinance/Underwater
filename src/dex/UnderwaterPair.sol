// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import {ERC20} from "../utils/ERC20.sol";
import {ReentrancyGuard} from "../utils/ReentrancyGuard.sol";
import {IERC20Minimal, IUnderwaterCallee, IUnderwaterFactory} from "./interfaces/IUnderwaterDex.sol";
import {Math} from "./libraries/Math.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {UQ112x112} from "./libraries/UQ112x112.sol";

/// @title UnderwaterPair
/// @notice Constant-product liquidity pool for a single token pair.
///
/// @dev This is a port of `UniswapV2Pair` to Solidity 0.8.26. The swap maths,
///      fee split, reserve packing, price accumulators and event signatures are
///      unchanged, because that exact design is the most heavily attacked and
///      most heavily audited AMM ever deployed and there is nothing to gain by
///      being creative here.
///
///      Porting notes — the original relies on Solidity 0.5's wrapping
///      arithmetic in precisely two places, both inside `_update`:
///
///        1. `timeElapsed = blockTimestamp - blockTimestampLast` must wrap so
///           the oracle keeps working past the uint32 rollover in 2106.
///        2. The two `price*CumulativeLast` accumulators must wrap, because
///           consumers only ever read the *difference* between two snapshots.
///
///      Both are marked `unchecked` and commented at the site. Everywhere else
///      the original used SafeMath, so 0.8's checked arithmetic reproduces the
///      original behaviour exactly. Getting this boundary wrong is the classic
///      way a V2 fork breaks, so `test/dex/PairOracle.t.sol` asserts the
///      rollover and accumulator-wrap behaviour directly.
///
///      Reserves are cached in one slot as two uint112s plus a uint32 timestamp,
///      which is why a pool cannot hold more than 2**112 - 1 of either token.
contract UnderwaterPair is ERC20, ReentrancyGuard {
    using UQ112x112 for uint224;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    error Forbidden();
    error AlreadyInitialized();
    error Overflow();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientInputAmount();
    error InsufficientLiquidity();
    error InvalidRecipient();
    error KInvariantViolated();

    /// @notice LP tokens burned on the first mint so `totalSupply` can never
    ///         return to zero.
    /// @dev Without this, an attacker could donate to a drained pool and make
    ///      the price of one LP wei arbitrarily large, rounding small
    ///      depositors down to nothing.
    uint256 public constant MINIMUM_LIQUIDITY = 10 ** 3;

    /// @notice The factory that deployed this pair.
    /// @dev Immutable rather than storage: `msg.sender` is not a constructor
    ///      argument, so the creation code stays byte-identical for every pair
    ///      and CREATE2 addresses remain derivable off-chain.
    address public immutable factory;

    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    /// @notice reserve0 * reserve1 as of the last liquidity event.
    /// @dev Only tracked while the protocol fee is switched on; the fee is
    ///      charged on growth in sqrt(k), which is growth that can only come
    ///      from accumulated swap fees.
    uint256 public kLast;

    constructor() ERC20("Underwater LP", "UW-LP", 18) {
        factory = msg.sender;
    }

    /// @notice Called once by the factory immediately after deployment.
    /// @dev Tokens are set here rather than in the constructor to keep the
    ///      creation code free of arguments.
    function initialize(address token0_, address token1_) external {
        if (msg.sender != factory) revert Forbidden();
        if (token0 != address(0)) revert AlreadyInitialized();
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves()
        public
        view
        returns (uint112 reserve0_, uint112 reserve1_, uint32 blockTimestampLast_)
    {
        reserve0_ = reserve0;
        reserve1_ = reserve1;
        blockTimestampLast_ = blockTimestampLast;
    }

    // ─── Liquidity ────────────────────────────────────────────────────────

    /// @notice Mint LP tokens for whatever was transferred in since the last sync.
    /// @dev Low-level: callers must send both tokens to this contract first, in
    ///      the same transaction. Use the router unless you know why not.
    function mint(address to) external nonReentrant returns (uint256 liquidity) {
        (uint112 reserve0_, uint112 reserve1_,) = getReserves();
        uint256 balance0 = _selfBalance(token0);
        uint256 balance1 = _selfBalance(token1);
        uint256 amount0 = balance0 - reserve0_;
        uint256 amount1 = balance1 - reserve1_;

        bool feeOn = _mintFee(reserve0_, reserve1_);
        // Read after _mintFee: minting the protocol fee changes totalSupply.
        uint256 supply = totalSupply;
        if (supply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY);
        } else {
            // Credit the scarcer side, so donating one token cannot mint LP.
            liquidity = Math.min(amount0 * supply / reserve0_, amount1 * supply / reserve1_);
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _update(balance0, balance1, reserve0_, reserve1_);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Burn LP tokens held by this contract and pay out both reserves.
    /// @dev Low-level: callers must transfer LP here first.
    function burn(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        (uint112 reserve0_, uint112 reserve1_,) = getReserves();
        address token0_ = token0;
        address token1_ = token1;
        uint256 balance0 = _selfBalance(token0_);
        uint256 balance1 = _selfBalance(token1_);
        uint256 liquidity = balanceOf[address(this)];

        bool feeOn = _mintFee(reserve0_, reserve1_);
        uint256 supply = totalSupply;
        // Balances, not reserves: donated tokens are distributed pro rata.
        amount0 = liquidity * balance0 / supply;
        amount1 = liquidity * balance1 / supply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        _burn(address(this), liquidity);
        SafeTransferLib.safeTransfer(token0_, to, amount0);
        SafeTransferLib.safeTransfer(token1_, to, amount1);

        _update(_selfBalance(token0_), _selfBalance(token1_), reserve0_, reserve1_);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Burn(msg.sender, amount0, amount1, to);
    }

    // ─── Trading ──────────────────────────────────────────────────────────

    /// @notice Swap, optionally as a flash swap.
    /// @dev Low-level: the input must already have been transferred in, or be
    ///      repaid from the `data` callback. The 0.3% fee is charged by
    ///      requiring k to grow, not by skimming a transfer.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data)
        external
        nonReentrant
    {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 reserve0_, uint112 reserve1_,) = getReserves();
        if (amount0Out >= reserve0_ || amount1Out >= reserve1_) revert InsufficientLiquidity();

        uint256 balance0;
        uint256 balance1;
        {
            address token0_ = token0;
            address token1_ = token1;
            // Sending output to a pool token would let the "input" be the
            // pool's own accounting, so it is rejected outright.
            if (to == token0_ || to == token1_) revert InvalidRecipient();
            if (amount0Out > 0) SafeTransferLib.safeTransfer(token0_, to, amount0Out);
            if (amount1Out > 0) SafeTransferLib.safeTransfer(token1_, to, amount1Out);
            if (data.length > 0) {
                IUnderwaterCallee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
            }
            balance0 = _selfBalance(token0_);
            balance1 = _selfBalance(token1_);
        }

        uint256 amount0In;
        uint256 amount1In;
        unchecked {
            // Both subtrahends are provably <= their minuend: amountOut was
            // checked against the reserve above, and each branch is guarded.
            uint256 owed0 = reserve0_ - amount0Out;
            uint256 owed1 = reserve1_ - amount1Out;
            amount0In = balance0 > owed0 ? balance0 - owed0 : 0;
            amount1In = balance1 > owed1 ? balance1 - owed1 : 0;
        }
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();
        {
            // 0.3% of each input stays in the pool: compare k after the swap
            // against k before, with inputs discounted by the fee.
            uint256 balance0Adjusted = balance0 * 1000 - amount0In * 3;
            uint256 balance1Adjusted = balance1 * 1000 - amount1In * 3;
            if (balance0Adjusted * balance1Adjusted < uint256(reserve0_) * reserve1_ * (1000 ** 2)) {
                revert KInvariantViolated();
            }
        }

        _update(balance0, balance1, reserve0_, reserve1_);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    // ─── Recovery ─────────────────────────────────────────────────────────

    /// @notice Sweep any balance above the cached reserves.
    /// @dev The escape hatch for a token whose balance drifts from the reserve
    ///      (rebasing, or a plain mistaken transfer).
    function skim(address to) external nonReentrant {
        address token0_ = token0;
        address token1_ = token1;
        SafeTransferLib.safeTransfer(token0_, to, _selfBalance(token0_) - reserve0);
        SafeTransferLib.safeTransfer(token1_, to, _selfBalance(token1_) - reserve1);
    }

    /// @notice Force the cached reserves to match actual balances.
    function sync() external nonReentrant {
        _update(_selfBalance(token0), _selfBalance(token1), reserve0, reserve1);
    }

    // ─── Internals ────────────────────────────────────────────────────────

    function _selfBalance(address token) private view returns (uint256) {
        return IERC20Minimal(token).balanceOf(address(this));
    }

    function _update(uint256 balance0, uint256 balance1, uint112 reserve0_, uint112 reserve1_) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();

        // The oracle only needs a monotonic clock modulo 2**32; truncating to
        // uint32 is what makes the reserves and timestamp share one slot.
        // forge-lint: disable-next-line(block-timestamp)
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        unchecked {
            // WRAPPING IS LOAD-BEARING (1/2): after the 2106 uint32 rollover
            // `blockTimestamp < blockTimestampLast`, and wrapping subtraction
            // still yields the correct elapsed seconds.
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            if (timeElapsed > 0 && reserve0_ != 0 && reserve1_ != 0) {
                // WRAPPING IS LOAD-BEARING (2/2): these accumulators are meant
                // to overflow. A TWAP is read as
                // (cumulative_now - cumulative_then) / (time_now - time_then),
                // and that difference is correct across any number of wraps.
                price0CumulativeLast += uint256(UQ112x112.encode(reserve1_).uqdiv(reserve0_)) * timeElapsed;
                price1CumulativeLast += uint256(UQ112x112.encode(reserve0_).uqdiv(reserve1_)) * timeElapsed;
            }
        }

        // Neither cast can truncate: the first line of this function reverts
        // with `Overflow` unless both balances fit in uint112.
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve0 = uint112(balance0);
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    /// @notice Mint the protocol's cut of accumulated swap fees to `feeTo`.
    /// @dev Charges 1/6 of the growth in sqrt(k) since the last liquidity
    ///      event, i.e. 0.05% of volume out of the pool's 0.3%, paid in LP
    ///      tokens rather than skimmed per swap. Returns whether the fee is on
    ///      so the caller knows to refresh `kLast`.
    function _mintFee(uint112 reserve0_, uint112 reserve1_) private returns (bool feeOn) {
        address feeTo = IUnderwaterFactory(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 kLast_ = kLast;

        if (feeOn) {
            if (kLast_ != 0) {
                uint256 rootK = Math.sqrt(uint256(reserve0_) * reserve1_);
                uint256 rootKLast = Math.sqrt(kLast_);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply * (rootK - rootKLast);
                    uint256 denominator = rootK * 5 + rootKLast;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (kLast_ != 0) {
            // Clear the marker while the fee is off, so switching it back on
            // cannot retroactively charge for growth accrued in between.
            kLast = 0;
        }
    }
}
