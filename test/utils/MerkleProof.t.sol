// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MerkleProof} from "../../src/utils/MerkleProof.sol";
import {Test} from "forge-std/Test.sol";

/// @dev `MerkleProof.verify` takes `calldata`, which a test cannot hand it
///      directly from memory. Going through an external call is also closer to
///      how the allowlist actually reaches it: off a transaction.
contract MerkleProofHarness {
    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) external pure returns (bool) {
        return MerkleProof.verify(proof, root, leaf);
    }
}

/// @notice The allowlist verifier, pinned against a tree built by an independent
///         implementation.
///
/// The vector below came out of `python script/whitelist.py --solidity`, which
/// builds the tree in Python against the vendored Keccak. Two implementations that
/// agree on a root is the only evidence worth having here: a verifier tested only
/// against a tree built by its own rules will happily accept a tree the real
/// off-chain tooling would never produce, and the failure shows up as an allowlist
/// nobody can mint against.
contract MerkleProofTest is Test {
    MerkleProofHarness harness;

    /// @dev Seven members, so both the leaf layer and the layer above it are odd
    ///      and a lone node has to be promoted rather than hashed against itself.
    ///      That choice changes the root, and getting it wrong is the single most
    ///      likely way for this tree to disagree with `merkletreejs`.
    bytes32 constant ROOT = 0x33f6b294c18c9f326bd80f187735cba60ac5399ea7d6700a5bada3dae6dc3126;

    address[] members;
    bytes32[][] proofs;

    function setUp() public {
        harness = new MerkleProofHarness();

        _member(
            0x1111111111111111111111111111111111111111,
            0x708e7cb9a75ffb24191120fba1c3001faa9078147150c6f2747569edbadee751,
            0xef9028a0c1c84c28cfb427c3c5db5d465e9299bf1a510dced4329cba0b4372f3,
            0xfe8746e2c76634a8abca349a38242a3f5fcc47f726a6f41cfecbc029815a124c
        );
        _member(
            0x2222222222222222222222222222222222222222,
            0xa7409058568815d08a7ad3c7d4fd44cf1dec90c620cb31e55ad24c654f7ba34f,
            0xef9028a0c1c84c28cfb427c3c5db5d465e9299bf1a510dced4329cba0b4372f3,
            0xfe8746e2c76634a8abca349a38242a3f5fcc47f726a6f41cfecbc029815a124c
        );
        _member(
            0x3333333333333333333333333333333333333333,
            0x1ede693ef734e17c8e0812c5ae5379839975b77cefe7b9eec7592c998b7fd2a2,
            0xc6ce8ae383124b268df66d71f0af2206e6dafb13eba0b03806eed8a4e7991329,
            0xfe8746e2c76634a8abca349a38242a3f5fcc47f726a6f41cfecbc029815a124c
        );
        _member(
            0x4444444444444444444444444444444444444444,
            0xbd164a4590db938a0b098da1b25cf37b155f857b38c37c016ad5b8f8fce80192,
            0xc6ce8ae383124b268df66d71f0af2206e6dafb13eba0b03806eed8a4e7991329,
            0xfe8746e2c76634a8abca349a38242a3f5fcc47f726a6f41cfecbc029815a124c
        );
        _member(
            0x5555555555555555555555555555555555555555,
            0x003709171ddb590c6e8548e55fe35d90ab970a43a6a1a560076174fc3ff9cd60,
            0xe886f259c341e5ebbd3773f1398401f2f7f81db556319e03c7683961780428bc,
            0xbcea17fcc9d10c2f150d77ec2940713e9885086b0fd54e20d20f6fea68543674
        );
        _member(
            0x6666666666666666666666666666666666666666,
            0xc1a4e2258434b8b7a69682d99b2b808571e2709f8c941bb348cacb8855522f9f,
            0xe886f259c341e5ebbd3773f1398401f2f7f81db556319e03c7683961780428bc,
            0xbcea17fcc9d10c2f150d77ec2940713e9885086b0fd54e20d20f6fea68543674
        );
        // The promoted member. Its proof is two siblings deep, not three, because
        // being alone at the end of an odd layer costs it no hash.
        _member(
            0x7777777777777777777777777777777777777777,
            0x05e585c0442e5cbf36cc097368f37f48ae0de1751789a3ea1f71aff72277671e,
            0xbcea17fcc9d10c2f150d77ec2940713e9885086b0fd54e20d20f6fea68543674
        );
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _member(address who, bytes32 s0, bytes32 s1, bytes32 s2) internal {
        members.push(who);
        bytes32[] storage p = proofs.push();
        p.push(s0);
        p.push(s1);
        p.push(s2);
    }

    function _member(address who, bytes32 s0, bytes32 s1) internal {
        members.push(who);
        bytes32[] storage p = proofs.push();
        p.push(s0);
        p.push(s1);
    }

    function _leaf(address who) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(who))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    // ─── The pinned vector ────────────────────────────────────────────────

    function test_everyMemberOfThePythonTreeVerifies() public view {
        for (uint256 i; i < members.length; ++i) {
            assertTrue(harness.verify(proofs[i], ROOT, _leaf(members[i])), "member did not verify");
        }
    }

    /// @dev Sorted pairs mean a proof carries no left/right flag, so the same
    ///      proof shape has to work whichever side of its sibling a leaf falls on.
    ///      Members 0 and 1 are siblings and sort opposite ways, which is the
    ///      cheapest demonstration that the ordering is decided by value.
    function test_aProofDoesNotSayWhichSideTheSiblingWasOn() public view {
        bytes32 first = _leaf(members[0]);
        bytes32 second = _leaf(members[1]);
        assertLt(uint256(second), uint256(first), "the fixture no longer straddles the sort order");

        assertTrue(harness.verify(proofs[0], ROOT, first));
        assertTrue(harness.verify(proofs[1], ROOT, second));
    }

    function test_rejectsAnAddressThatIsNotInTheTree() public view {
        bytes32 outsider = _leaf(0x8888888888888888888888888888888888888888);
        for (uint256 i; i < proofs.length; ++i) {
            assertFalse(harness.verify(proofs[i], ROOT, outsider), "outsider verified");
        }
    }

    function test_rejectsATamperedSibling() public view {
        bytes32[] memory proof = proofs[0];
        for (uint256 i; i < proof.length; ++i) {
            bytes32 original = proof[i];
            proof[i] = bytes32(uint256(original) ^ 1); // one bit
            assertFalse(harness.verify(proof, ROOT, _leaf(members[0])), "tampered proof verified");
            proof[i] = original;
        }
    }

    /// @dev Sorting decides which of two nodes goes first *within* a step; it does
    ///      not make the steps themselves interchangeable, because each one is a
    ///      different level of the tree.
    function test_rejectsAProofWithItsStepsReordered() public view {
        bytes32[] memory proof = proofs[0];
        (proof[0], proof[2]) = (proof[2], proof[0]);
        assertFalse(harness.verify(proof, ROOT, _leaf(members[0])));
    }

    function test_rejectsATruncatedOrPaddedProof() public view {
        bytes32[] memory short_ = new bytes32[](2);
        short_[0] = proofs[0][0];
        short_[1] = proofs[0][1];
        assertFalse(harness.verify(short_, ROOT, _leaf(members[0])));

        bytes32[] memory long_ = new bytes32[](4);
        for (uint256 i; i < 3; ++i) {
            long_[i] = proofs[0][i];
        }
        long_[3] = keccak256("extra");
        assertFalse(harness.verify(long_, ROOT, _leaf(members[0])));
    }

    /// @dev An empty proof against a single-leaf tree is legitimate, and the
    ///      library says so rather than treating a zero-length proof as invalid.
    ///      It is also why `UnderwaterPlates` refuses a zero root outright: with
    ///      one, an empty proof would verify a zero leaf.
    function test_aSingleLeafTreeIsItsOwnRoot() public view {
        bytes32[] memory none = new bytes32[](0);
        bytes32 only = _leaf(members[0]);

        assertTrue(harness.verify(none, only, only));
        assertFalse(harness.verify(none, only, _leaf(members[1])));
        assertTrue(harness.verify(none, bytes32(0), bytes32(0)), "the case the caller must reject");
    }

    /// @dev `verify` will happily accept an internal node as a leaf — nothing in
    ///      the loop can tell them apart. That is not a bug here, it is the reason
    ///      `UnderwaterPlates._leaf` hashes twice: an internal node is always the
    ///      hash of 64 bytes, a leaf always the hash of 32, so no address can be
    ///      made to land on one. This test exists so that if the double hash is
    ///      ever dropped, the reason it was there is still written down.
    function test_anInternalNodeVerifiesAsALeaf() public view {
        bytes32 node = _pair(_leaf(members[0]), _leaf(members[1])); // layer 1, index 0

        bytes32[] memory proof = new bytes32[](2);
        proof[0] = proofs[0][1]; // its sibling one layer up
        proof[1] = proofs[0][2];

        assertTrue(harness.verify(proof, ROOT, node), "an internal node is indistinguishable from a leaf");
    }

    // ─── Trees of every shape ─────────────────────────────────────────────

    /// @dev Sizes 1..64 rather than a fuzzed count: the interesting cases are all
    ///      at specific shapes — powers of two, one past them, and the long runs of
    ///      odd layers in between — and enumerating them is both cheaper and more
    ///      complete than sampling.
    function test_everyMemberProvesInTreesOfEverySizeUpTo64() public view {
        for (uint256 size = 1; size <= 64; ++size) {
            (bytes32 root, bytes32[][] memory layers) = _build(size);

            for (uint256 i; i < size; ++i) {
                assertTrue(harness.verify(_pathTo(layers, i), root, layers[0][i]), "member failed");
            }

            bytes32 outsider = _leaf(address(uint160(0xdead0000 + size)));
            assertFalse(harness.verify(_pathTo(layers, 0), root, outsider), "outsider verified");
        }
    }

    /// @dev A member of one tree must not prove against another's root. Otherwise
    ///      replacing the allowlist would not actually replace it.
    function test_aProofDoesNotCarryToAnotherTree() public view {
        (bytes32 rootA, bytes32[][] memory layersA) = _build(9);
        (bytes32 rootB,) = _build(10);

        assertTrue(harness.verify(_pathTo(layersA, 3), rootA, layersA[0][3]));
        assertFalse(harness.verify(_pathTo(layersA, 3), rootB, layersA[0][3]));
    }

    function _build(uint256 size) internal pure returns (bytes32 root, bytes32[][] memory layers) {
        // Depth is ceil(log2(size)) + 1, and 7 layers holds anything up to 64.
        bytes32[][] memory scratch = new bytes32[][](8);
        uint256 depth;

        bytes32[] memory level = new bytes32[](size);
        for (uint256 i; i < size; ++i) {
            level[i] = _leaf(address(uint160(i + 1)));
        }
        scratch[depth++] = level;

        while (level.length > 1) {
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i; i < next.length; ++i) {
                next[i] = 2 * i + 1 < level.length ? _pair(level[2 * i], level[2 * i + 1]) : level[2 * i];
            }
            scratch[depth++] = next;
            level = next;
        }

        layers = new bytes32[][](depth);
        for (uint256 i; i < depth; ++i) {
            layers[i] = scratch[i];
        }
        root = level[0];
    }

    function _pathTo(bytes32[][] memory layers, uint256 index)
        internal
        pure
        returns (bytes32[] memory proof)
    {
        bytes32[] memory scratch = new bytes32[](layers.length);
        uint256 n;

        for (uint256 depth; depth + 1 < layers.length; ++depth) {
            uint256 sibling = index ^ 1;
            if (sibling < layers[depth].length) scratch[n++] = layers[depth][sibling];
            index /= 2;
        }

        proof = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            proof[i] = scratch[i];
        }
    }
}
