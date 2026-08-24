// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterPlates} from "../src/nft/UnderwaterPlates.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Writes the packed trait table to a deployed collection and seals it,
///         which is what opens minting.
///
/// The table is checked against the on-chain `provenance` locally, before the
/// first transaction is sent. `seal` would reject a wrong table anyway, but it
/// would do so after six commit transactions have already been paid for, and the
/// operator would be left guessing which word is wrong.
///
/// Dry run (verifies the table without sending anything):
///   PLATES=0x… PLATES_TABLE=1,2,3,… forge script script/SealPlates.s.sol --rpc-url ink
///
/// Broadcast:
///   forge script script/SealPlates.s.sol --rpc-url ink --broadcast
contract SealPlates is Script {
    /// @dev Words per transaction. 371 words at ~20k gas each does not fit in one
    ///      transaction at a comfortable margin, and a batch that only just fits
    ///      is a batch that fails when the base fee moves.
    uint256 constant BATCH = 64;

    function run() external {
        UnderwaterPlates plates = UnderwaterPlates(vm.envAddress("PLATES"));
        uint256[] memory words = vm.envUint("PLATES_TABLE", ",");

        uint256 expected = plates.TABLE_WORDS();
        require(words.length == expected, "PLATES_TABLE must be exactly TABLE_WORDS words");
        require(!plates.isSealed(), "already sealed");

        bytes32 provenance = plates.provenance();
        bytes32 local = keccak256(abi.encode(words));

        console2.log("chain id        ", block.chainid);
        console2.log("plates          ", address(plates));
        console2.log("words           ", words.length);
        console2.log("provenance      ", vm.toString(provenance));
        console2.log("table hashes to ", vm.toString(local));

        // The same encoding `seal` recomputes on chain, so a match here means the
        // seal will succeed and a mismatch means it would have burned the gas.
        require(local == provenance, "table does not hash to provenance - wrong table or wrong file");

        uint256 batches = (expected + BATCH - 1) / BATCH;
        console2.log("commit txs      ", batches);
        console2.log("");

        vm.startBroadcast();
        for (uint256 start; start < expected; start += BATCH) {
            uint256 n = expected - start < BATCH ? expected - start : BATCH;
            uint256[] memory chunk = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                chunk[i] = words[start + i];
            }
            plates.commit(start, chunk);
        }
        plates.seal();
        vm.stopBroadcast();

        require(plates.isSealed(), "seal did not take");

        console2.log("Sealed. The art on chain is the art that was committed to.");
        console2.log("reserve minted to treasury  ", plates.minted());
        console2.log("price (wei)                 ", plates.price());
        console2.log("wl price (wei)              ", plates.wlPrice());
        console2.log("mint closes at              ", plates.mintCloses());
        console2.log("");
        console2.log("Neither phase is open yet. The seal is one of two gates:");
        console2.log("  allowlist  script/SetWhitelist.s.sol   (sets the root)");
        console2.log("  public     cast send <plates> 'openPublicMint()'");
        console2.log("");
        console2.log("Reveal is permissionless once the collection sells out or the");
        console2.log("window closes:  cast send <plates> 'reveal()'");
    }
}
