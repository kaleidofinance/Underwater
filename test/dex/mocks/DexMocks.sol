// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUnderwaterPair} from "../../../src/dex/interfaces/IUnderwaterDex.sol";
import {ERC20} from "../../../src/utils/ERC20.sol";

/// @notice Canonical WETH9, matching the OP Stack predeploy behaviour that the
///         router depends on (`deposit`, `withdraw`, ETH refund on withdraw).
contract WETH9 is ERC20 {
    event Deposit(address indexed to, uint256 amount);
    event Withdrawal(address indexed from, uint256 amount);

    constructor() ERC20("Wrapped Ether", "WETH", 18) {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "WETH_WITHDRAW_FAILED");
    }
}

/// @notice Plain mintable ERC20 for pool tests.
contract TestERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_, 18) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Token that burns 1% of every transfer, to exercise the router's
///         fee-on-transfer code paths.
contract TaxToken is ERC20 {
    uint256 public constant TAX_BPS = 100;

    constructor() ERC20("Tax Token", "TAX", 18) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 tax = amount * TAX_BPS / 10_000;
        _burn(msg.sender, tax);
        return super.transfer(to, amount - tax);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        uint256 tax = amount * TAX_BPS / 10_000;
        _burn(from, tax);
        uint256 net = amount - tax;
        balanceOf[from] -= net;
        unchecked {
            balanceOf[to] += net;
        }
        emit Transfer(from, to, net);
        return true;
    }
}

/// @notice Flash-swap borrower that repays the 0.3% fee out of its own balance.
contract FlashBorrower {
    address public immutable pair;

    bool public repay = true;

    error CallbackNotFromPair();

    constructor(address pair_) {
        pair = pair_;
    }

    function setRepay(bool value) external {
        repay = value;
    }

    /// @param token The token being borrowed.
    /// @param amount How much to borrow.
    function borrow(address token, uint256 amount) external {
        (uint256 amount0Out, uint256 amount1Out) =
            token == IUnderwaterPair(pair).token0() ? (amount, uint256(0)) : (uint256(0), amount);
        IUnderwaterPair(pair).swap(amount0Out, amount1Out, address(this), abi.encode(token, amount));
    }

    function uniswapV2Call(address, uint256, uint256, bytes calldata data) external {
        if (msg.sender != pair) revert CallbackNotFromPair();
        if (!repay) return;
        (address token, uint256 amount) = abi.decode(data, (address, uint256));
        // Repay principal plus the fee the k invariant will demand.
        uint256 owed = amount * 1000 / 997 + 1;
        ERC20(token).transfer(pair, owed);
    }
}

/// @notice Flash borrower that tries to reenter the pool during the callback.
contract PairReenterer {
    address public immutable pair;

    constructor(address pair_) {
        pair = pair_;
    }

    function attack(uint256 amount0Out, uint256 amount1Out) external {
        IUnderwaterPair(pair).swap(amount0Out, amount1Out, address(this), abi.encode(uint256(1)));
    }

    function uniswapV2Call(address, uint256, uint256, bytes calldata) external {
        // Reentering any locked entry point must revert.
        IUnderwaterPair(pair).sync();
    }
}
