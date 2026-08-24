// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterPlates} from "../src/nft/UnderwaterPlates.sol";
import {MerkleProof} from "../src/utils/MerkleProof.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Sets the allowlist root, which opens the allowlist phase.
///
/// The root comes from `python script/whitelist.py`. Before broadcasting, this
/// re-verifies a proof from that run against the root using the same library the
/// contract uses — because the failure mode of a wrong root is silent: the
/// transaction succeeds, and then nobody on the list can mint. Checking one member
/// costs nothing and catches a tree built by different rules.
///
/// Dry run (verifies the proof without sending anything):
///   PLATES=0x… WL_ROOT=0x… WL_MEMBER=0x… WL_PROOF=0x…,0x… \
///     forge script script/SetWhitelist.s.sol --rpc-url ink
///
/// Broadcast:
///   forge script script/SetWhitelist.s.sol --rpc-url ink --broadcast
contract SetWhitelist is Script {
    function run() external {
        UnderwaterPlates plates = UnderwaterPlates(vm.envAddress("PLATES"));
        bytes32 root = vm.envBytes32("WL_ROOT");
        // Optional, but skipping it means broadcasting a root nothing has checked.
        address member = vm.envOr("WL_MEMBER", address(0));

        require(root != bytes32(0), "WL_ROOT is zero - that would leave the allowlist shut");

        console2.log("chain id        ", block.chainid);
        console2.log("plates          ", address(plates));
        console2.log("current root    ", vm.toString(plates.merkleRoot()));
        console2.log("new root        ", vm.toString(root));
        console2.log("wl allocation   ", plates.WL_ALLOCATION());
        console2.log("wl minted so far", plates.wlMinted());
        console2.log("wl price (wei)  ", plates.wlPrice());
        console2.log("max per wallet  ", plates.maxPerWallet());

        if (member == address(0)) {
            console2.log("");
            console2.log("! WL_MEMBER not set, so this root is unverified. Set WL_MEMBER and");
            console2.log("! WL_PROOF to one entry from web/whitelist.json first.");
        } else {
            bytes32[] memory proof = vm.envOr("WL_PROOF", ",", new bytes32[](0));
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(member))));

            console2.log("");
            console2.log("checking        ", member);
            console2.log("leaf            ", vm.toString(leaf));
            console2.log("proof length    ", proof.length);

            // Checked through the same library the contract uses rather than a
            // reimplementation, so a pass here is the pass that matters. The hop
            // through `this` is only how a memory array reaches a `calldata`
            // parameter.
            require(this.verifyProof(proof, root, leaf), "proof does not verify against WL_ROOT");
            console2.log("proof verifies against the new root");
        }

        vm.startBroadcast();
        plates.setMerkleRoot(root);
        vm.stopBroadcast();

        require(plates.merkleRoot() == root, "root did not take");

        console2.log("");
        console2.log("Allowlist is open. Members mint with:");
        console2.log("  cast send <plates> 'mintWhitelist(uint256,bytes32[])' <qty> '[<proof>]' \\");
        console2.log("    --value <qty * wlPrice>");
        console2.log("");
        console2.log("Open the public phase when the allowlist is done:");
        console2.log("  cast send <plates> 'openPublicMint()'");
    }

    /// @dev External only so a memory array can reach the library's `calldata`
    ///      parameter — the ABI encoder does the copy on the way through `this`.
    function verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf) external pure returns (bool) {
        return MerkleProof.verify(proof, root, leaf);
    }
}
