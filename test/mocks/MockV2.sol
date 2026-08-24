// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Stand-in for WETH. Only the address identity matters to the tests.
contract MockWETH {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
}

/// @notice Stand-in for a V2 pair; records the liquidity it was credited.
contract MockPair {
    address public immutable token0;
    address public immutable token1;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }
}

contract MockV2Factory {
    mapping(address => mapping(address => address)) internal _pairs;

    function getPair(address tokenA, address tokenB) external view returns (address) {
        return _pairs[tokenA][tokenB];
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        pair = address(new MockPair(tokenA, tokenB));
        _pairs[tokenA][tokenB] = pair;
        _pairs[tokenB][tokenA] = pair;
    }
}

/// @notice Faithful-enough V2 router for graduation tests.
/// @dev `tokenConsumeBps` / `ethConsumeBps` simulate a pre-existing pair with a
///      skewed reserve ratio, where the pool takes less than it was offered and
///      the router refunds the remainder — the case the launchpad must sweep.
contract MockV2Router {
    address public immutable factory;
    address public immutable WETH;

    uint256 public tokenConsumeBps = 10_000;
    uint256 public ethConsumeBps = 10_000;
    bool public shouldRevert;

    error Forced();
    error InsufficientAmount();

    constructor() {
        factory = address(new MockV2Factory());
        WETH = address(new MockWETH());
    }

    function setConsumeBps(uint256 tokenBps, uint256 ethBps) external {
        tokenConsumeBps = tokenBps;
        ethConsumeBps = ethBps;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 /* deadline */
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        if (shouldRevert) revert Forced();

        amountToken = (amountTokenDesired * tokenConsumeBps) / 10_000;
        amountETH = (msg.value * ethConsumeBps) / 10_000;
        if (amountToken < amountTokenMin || amountETH < amountETHMin) revert InsufficientAmount();

        MockV2Factory f = MockV2Factory(factory);
        address pair = f.getPair(token, WETH);
        if (pair == address(0)) pair = f.createPair(token, WETH);

        IERC20Min(token).transferFrom(msg.sender, pair, amountToken);

        // Geometric mean, as V2 does for a fresh pool.
        liquidity = _sqrt(amountToken * amountETH);
        MockPair(pair).mint(to, liquidity);

        if (msg.value > amountETH) {
            (bool ok,) = msg.sender.call{value: msg.value - amountETH}("");
            require(ok, "REFUND_FAILED");
        }
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}

/// @notice Recipient that rejects ETH, to exercise the transfer-failure path.
contract RejectingRecipient {
    receive() external payable {
        revert("NOPE");
    }
}
