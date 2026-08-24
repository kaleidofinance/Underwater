// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import {IERC20Minimal} from "../interfaces/IUnderwaterDex.sol";

/// @notice ERC20 and ETH transfers that tolerate non-standard tokens.
/// @dev A DEX has to move tokens it did not write. Some return no value at all
///      (early USDT-style), some return `false` instead of reverting. Treating
///      an empty return as success and a `false` return as failure covers both
///      without trusting the token to behave.
library SafeTransferLib {
    error TransferFailed();
    error TransferFromFailed();
    error ApproveFailed();
    error EthTransferFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
        if (!_succeeded(ok, ret)) revert TransferFailed();
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
        if (!_succeeded(ok, ret)) revert TransferFromFailed();
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Minimal.approve, (spender, amount)));
        if (!_succeeded(ok, ret)) revert ApproveFailed();
    }

    function safeTransferETH(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @dev Success means the call did not revert AND either returned nothing
    ///      or returned a decodable `true`. A short non-empty return is treated
    ///      as failure rather than decoded, because `abi.decode` on fewer than
    ///      32 bytes reverts with an opaque panic.
    function _succeeded(bool ok, bytes memory ret) private pure returns (bool) {
        if (!ok) return false;
        if (ret.length == 0) return true;
        if (ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }
}
