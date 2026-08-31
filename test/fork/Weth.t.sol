// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Weth} from "../../script/Weth.sol";
import {IWETH} from "../../src/dex/interfaces/IUnderwaterDex.sol";
import {Test} from "forge-std/Test.sol";

interface IERC20Metadata {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// @notice Checks every entry in [Weth](../../script/Weth.sol) against the live chain
///         it claims to describe.
///
/// The router's `WETH` is immutable, so a wrong entry in that table cannot be corrected
/// after a deploy — and the two Robinhood addresses are ordinary deployments rather than
/// a predeploy at a well-known address, which is exactly the kind of fact that rots. So
/// the table is a test subject: each entry must have code on its chain, must credit a
/// deposit one-for-one, and must pay native ETH back on withdraw. A mock cannot stand in
/// for any of that, which is the whole point.
///
/// Deliberately asserts `block.chainid` too. Without it an RPC quietly pointed at the
/// wrong network would test one chain's address against another's state and pass or fail
/// for reasons that have nothing to do with the table.
///
/// Skipped automatically when the RPC is unreachable, so `forge test` stays green
/// offline. Run explicitly with:
///   forge test --match-contract Weth -vv
abstract contract WethTableForkTest is Test {
    bool internal forked;
    address internal weth;

    function _rpc() internal view virtual returns (string memory);

    function _label() internal pure virtual returns (string memory);

    function _chainId() internal pure virtual returns (uint256);

    function setUp() public {
        // Resolved from the declared id rather than from `block.chainid`, so the
        // assertion below is a real check of the pair rather than a tautology.
        weth = Weth.forChain(_chainId());
        try vm.createSelectFork(_rpc()) {
            forked = true;
        } catch {
            emit log(string.concat(_label(), " RPC unreachable - skipping fork test"));
        }
    }

    function test_rpcIsTheChainThisEntryClaims() public view {
        if (!forked) return;
        assertEq(block.chainid, _chainId(), "RPC is not the chain this entry describes");
    }

    function test_tableEntryIsWeth9OnThisChain() public {
        if (!forked) return;
        assertGt(weth.code.length, 0, "no code at the address in the table");

        // 18 decimals and the name, so a table entry that is *a* contract but not the
        // wrapped-ETH one fails here rather than in the reserves of a live pool.
        assertEq(IERC20Metadata(weth).decimals(), 18, "not an 18-decimal token");
        assertEq(IERC20Metadata(weth).symbol(), "WETH", "symbol is not WETH");

        address holder = makeAddr("holder");
        vm.deal(holder, 3 ether);

        vm.startPrank(holder);
        IWETH(weth).deposit{value: 2 ether}();
        assertEq(IWETH(weth).balanceOf(holder), 2 ether, "deposit did not credit one for one");

        // The leg that matters most to us: the router unwraps through this on every
        // sell, and a `withdraw` that does not pay native ETH back strands the seller.
        IWETH(weth).withdraw(1 ether);
        vm.stopPrank();

        assertEq(IWETH(weth).balanceOf(holder), 1 ether, "withdraw did not debit one for one");
        assertEq(holder.balance, 2 ether, "withdraw did not pay native ETH back");

        emit log_named_address(string.concat(_label(), " WETH"), weth);
    }
}

contract InkWethForkTest is WethTableForkTest {
    function _rpc() internal view override returns (string memory) {
        return vm.envOr("INK_RPC_URL", string("https://rpc-gel.inkonchain.com"));
    }

    function _label() internal pure override returns (string memory) {
        return "Ink mainnet";
    }

    function _chainId() internal pure override returns (uint256) {
        return 57073;
    }
}

contract InkSepoliaWethForkTest is WethTableForkTest {
    function _rpc() internal view override returns (string memory) {
        return vm.envOr("INK_SEPOLIA_RPC_URL", string("https://rpc-gel-sepolia.inkonchain.com"));
    }

    function _label() internal pure override returns (string memory) {
        return "Ink Sepolia";
    }

    function _chainId() internal pure override returns (uint256) {
        return 763373;
    }
}

/// @notice Robinhood Chain is Arbitrum Nitro, so this address is a deployment rather
///         than a predeploy — and a proxied, upgradeable one. Both are reasons the
///         entry is worth re-checking rather than trusted.
contract RobinhoodWethForkTest is WethTableForkTest {
    function _rpc() internal view override returns (string memory) {
        return vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
    }

    function _label() internal pure override returns (string memory) {
        return "Robinhood Chain";
    }

    function _chainId() internal pure override returns (uint256) {
        return 4663;
    }
}

contract RobinhoodTestnetWethForkTest is WethTableForkTest {
    function _rpc() internal view override returns (string memory) {
        return vm.envOr("ROBINHOOD_TESTNET_RPC_URL", string("https://rpc.testnet.chain.robinhood.com"));
    }

    function _label() internal pure override returns (string memory) {
        return "Robinhood Chain Testnet";
    }

    function _chainId() internal pure override returns (uint256) {
        return 46630;
    }
}
