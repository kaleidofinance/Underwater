// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Base64 encoder for on-chain data URIs.
/// @dev Standard alphabet with `=` padding, which is what `data:` URIs and every
///      marketplace metadata parser expect.
library Base64 {
    string internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function encode(bytes memory data) internal pure returns (string memory result) {
        if (data.length == 0) return "";

        // Inline assembly cannot reference a constant directly, so the table has
        // to be materialised in memory first.
        string memory table = TABLE;

        // 3 input bytes -> 4 output chars, rounded up to a whole group.
        result = new string(4 * ((data.length + 2) / 3));

        assembly {
            let tablePtr := add(table, 1)
            let dataPtr := data
            let endPtr := add(dataPtr, mload(data))

            // The loop reads 32 bytes at a time and uses the low 3, so the last
            // read runs up to 2 bytes past the input. Those bytes must be zero
            // or they corrupt the final characters, and the word after `data` is
            // only reliably zero when the length is a multiple of 32. Blank it
            // and put it back afterwards.
            let afterPtr := add(endPtr, 0x20)
            let afterCache := mload(afterPtr)
            mstore(afterPtr, 0x00)

            let resultPtr := add(result, 0x20)

            for {} lt(dataPtr, endPtr) {} {
                dataPtr := add(dataPtr, 3)
                let input := mload(dataPtr)

                mstore8(resultPtr, mload(add(tablePtr, and(shr(18, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(12, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(6, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(input, 0x3F))))
                resultPtr := add(resultPtr, 1)
            }

            mstore(afterPtr, afterCache)

            // Overwrite the tail with '=' for each byte the last group lacked.
            switch mod(mload(data), 3)
            case 1 {
                mstore8(sub(resultPtr, 1), 0x3d)
                mstore8(sub(resultPtr, 2), 0x3d)
            }
            case 2 { mstore8(sub(resultPtr, 1), 0x3d) }
        }
    }
}
