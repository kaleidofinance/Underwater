// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterPlates} from "../../src/nft/UnderwaterPlates.sol";
import {UnderwaterTrophy} from "../../src/nft/UnderwaterTrophy.sol";
import {ERC721} from "../../src/utils/ERC721.sol";
import {Owned} from "../../src/utils/Owned.sol";
import {ReentrancyGuard} from "../../src/utils/ReentrancyGuard.sol";
import {BadReceiver, GoodReceiver, MockAavePool, MockRenderer, ReentrantReceiver} from "./mocks/NftMocks.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The plates collection: pre-committed traits, post-mint reveal, and a
///         health factor that can burn the art out from under its holder.
contract PlatesTest is Test {
    UnderwaterPlates plates;
    UnderwaterTrophy trophy;
    MockAavePool pool;
    MockRenderer renderer;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address hunter = makeAddr("hunter");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address erin = makeAddr("erin");

    uint256 constant SUPPLY = 2222;
    uint256 constant TABLE_WORDS = 371;
    uint256 constant PLATES_PER_WORD = 6;
    uint256 constant BITS_PER_PLATE = 40;
    uint256 constant CATEGORIES = 10;
    uint256 constant TRAIT_BITS = 4;

    uint256 constant PRICE = 0.0222 ether;
    uint256 constant WL_PRICE = 0.00333 ether;
    uint256 constant RESERVE = 22;
    uint256 constant WINDOW = 30 days;

    uint256 constant WL_ALLOCATION = 2000;
    uint256 constant PRICE_CEILING = 1 ether;
    uint256 constant LIMIT_CEILING = 222;

    /// @dev Option counts per category at 8 bits each, lowest byte first, in the
    ///      order the renderer reads them: diver 6, headgear 5, held 6, relic 15,
    ///      emblem 8, scene 5, tether 4, fauna 4, pigment 5, substrate 4. Mirrors
    ///      the generator, and pins the claim that 4 bits per category is enough —
    ///      the widest is relic at 15.
    uint256 constant OPTIONS = 0x04_05_04_04_05_08_0f_06_05_06;

    /// @dev The committed table, held locally so tests can check the contract
    ///      returns what was hashed rather than trusting it to agree with itself.
    uint256[] table;
    uint256 mintCloses;

    /// @dev Allowlist tree, layer 0 being the leaves. Built once in `setUp` and
    ///      never rebuilt, so no layer is ever stale.
    bytes32[][] wlTree;
    bytes32 wlRoot;

    function setUp() public {
        pool = new MockAavePool();
        renderer = new MockRenderer();

        (uint256[] memory words, bytes32 provenance) = _buildTable();
        table = words;
        mintCloses = block.timestamp + WINDOW;

        plates = new UnderwaterPlates(
            owner, address(pool), treasury, provenance, PRICE, WL_PRICE, RESERVE, mintCloses
        );
        trophy = plates.trophy();

        vm.prank(owner);
        plates.setRenderer(address(renderer));

        // Five members, so both the leaf layer and the layer above it are odd and
        // the promote-the-lone-node path is exercised. `bob` is deliberately left
        // out: he is the canonical outsider in the allowlist tests.
        address[] memory members = new address[](5);
        members[0] = alice;
        members[1] = hunter;
        members[2] = carol;
        members[3] = dave;
        members[4] = erin;
        wlRoot = _buildWhitelist(members);

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(hunter, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(dave, 100 ether);
        vm.deal(erin, 100 ether);
        vm.deal(address(this), 100 ether);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _optionCount(uint256 category) internal pure returns (uint256) {
        return (OPTIONS >> (category * 8)) & 0xff;
    }

    /// @dev A deterministic stand-in for the real generator's output. The
    ///      contract is indifferent to what the traits are; it only enforces that
    ///      the table on chain is the one that was hashed.
    function _traitsFor(uint256 slot) internal pure returns (uint256 packed) {
        uint256 entropy = uint256(keccak256(abi.encode(slot)));
        for (uint256 c; c < CATEGORIES; ++c) {
            uint256 index = (entropy >> (c * 8)) % _optionCount(c);
            packed |= index << (c * TRAIT_BITS);
        }
    }

    function _buildTable() internal pure returns (uint256[] memory words, bytes32 hash_) {
        words = new uint256[](TABLE_WORDS);
        for (uint256 slot; slot < SUPPLY; ++slot) {
            words[slot / PLATES_PER_WORD] |= _traitsFor(slot) << (slot % PLATES_PER_WORD * BITS_PER_PLATE);
        }
        hash_ = keccak256(abi.encode(words));
    }

    function _commit() internal {
        uint256 batch = 128;
        vm.startPrank(owner);
        for (uint256 i; i < TABLE_WORDS; i += batch) {
            uint256 n = TABLE_WORDS - i < batch ? TABLE_WORDS - i : batch;
            uint256[] memory chunk = new uint256[](n);
            for (uint256 j; j < n; ++j) {
                chunk[j] = table[i + j];
            }
            plates.commit(i, chunk);
        }
        vm.stopPrank();
    }

    /// @dev Table committed, provenance verified, minting open.
    function _sealed() internal {
        _commit();
        vm.prank(owner);
        plates.seal();
    }

    /// @dev Sealed, with the public phase open. What most tests want.
    function _open() internal {
        _sealed();
        vm.prank(owner);
        plates.openPublicMint();
    }

    /// @dev Sealed, with the allowlist live and the public phase still shut.
    function _openWhitelist() internal {
        _sealed();
        vm.prank(owner);
        plates.setMerkleRoot(wlRoot);
    }

    function _mintTo(address to, uint256 qty) internal returns (uint256 firstId) {
        firstId = plates.minted() + 1;
        vm.prank(to);
        plates.mint{value: PRICE * qty}(qty);
    }

    function _mintWhitelist(address to, uint256 qty) internal returns (uint256 firstId) {
        firstId = plates.minted() + 1;
        vm.prank(to);
        plates.mintWhitelist{value: WL_PRICE * qty}(qty, _proof(to));
    }

    // ─── Allowlist tree ───────────────────────────────────────────────────

    /// @dev Built the way the off-chain tooling builds it, because a tree the
    ///      contract accepts but `merkletreejs` cannot reproduce is worse than no
    ///      test: sorted pairs, double-hashed leaves, and a lone node at the end
    ///      of an odd layer promoted rather than hashed against itself.
    function _buildWhitelist(address[] memory members) internal returns (bytes32 root) {
        bytes32[] memory level = new bytes32[](members.length);
        for (uint256 i; i < members.length; ++i) {
            level[i] = _leaf(members[i]);
        }
        wlTree.push(level);

        while (level.length > 1) {
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i; i < next.length; ++i) {
                next[i] = 2 * i + 1 < level.length ? _pair(level[2 * i], level[2 * i + 1]) : level[2 * i];
            }
            wlTree.push(next);
            level = next;
        }

        root = level[0];
    }

    /// @dev The sibling hashes on the path from `member`'s leaf to the root. A
    ///      promoted lone node contributes nothing, which is why the proof is
    ///      sized by what was actually collected rather than by the tree depth.
    function _proof(address member) internal view returns (bytes32[] memory proof) {
        bytes32 leaf = _leaf(member);
        uint256 index = type(uint256).max;
        for (uint256 i; i < wlTree[0].length; ++i) {
            if (wlTree[0][i] == leaf) index = i;
        }
        require(index != type(uint256).max, "member not in the tree");

        bytes32[] memory scratch = new bytes32[](wlTree.length);
        uint256 n;
        for (uint256 depth; depth + 1 < wlTree.length; ++depth) {
            uint256 sibling = index ^ 1;
            if (sibling < wlTree[depth].length) scratch[n++] = wlTree[depth][sibling];
            index /= 2;
        }

        proof = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            proof[i] = scratch[i];
        }
    }

    function _leaf(address member) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(member))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Reveal without selling out, by letting the mint window close.
    function _revealByDeadline() internal {
        vm.warp(mintCloses + 1);
        vm.roll(block.number + 64);
        plates.reveal();
    }

    /// @dev A plate held by `who` with their position attached and `hf` reported.
    function _diving(address who, uint256 hf) internal returns (uint256 id) {
        id = _mintTo(who, 1);
        pool.setHealthFactor(who, hf);
        vm.prank(who);
        plates.dive(id);
    }

    function _expectedTraits(uint256 id) internal view returns (uint256) {
        uint256 slot = (id - 1 + plates.revealOffset()) % SUPPLY;
        return (table[slot / PLATES_PER_WORD] >> (slot % PLATES_PER_WORD * BITS_PER_PLATE))
            & ((1 << BITS_PER_PLATE) - 1);
    }

    // ─── Constructor ──────────────────────────────────────────────────────

    function test_constructorRejectsOversizedReserve() public {
        vm.expectRevert(UnderwaterPlates.ReserveTooLarge.selector);
        new UnderwaterPlates(
            owner, address(pool), treasury, bytes32(0), PRICE, WL_PRICE, SUPPLY / 10 + 1, mintCloses
        );
    }

    function test_constructorAcceptsReserveAtCeiling() public {
        UnderwaterPlates p = new UnderwaterPlates(
            owner, address(pool), treasury, bytes32(0), PRICE, WL_PRICE, SUPPLY / 10, mintCloses
        );
        assertEq(p.reserve(), 222, "10% of 2222");
    }

    function test_constructorRejectsZeroPool() public {
        vm.expectRevert(Owned.ZeroAddress.selector);
        new UnderwaterPlates(owner, address(0), treasury, bytes32(0), PRICE, WL_PRICE, RESERVE, mintCloses);
    }

    function test_constructorRejectsZeroTreasury() public {
        vm.expectRevert(Owned.ZeroAddress.selector);
        new UnderwaterPlates(
            owner, address(pool), address(0), bytes32(0), PRICE, WL_PRICE, RESERVE, mintCloses
        );
    }

    /// @dev Both prices are bounded at deploy by the same ceiling the setters
    ///      enforce, so a launch cannot start outside the range the owner is
    ///      afterwards held to.
    function test_constructorRejectsPricesOverTheCeiling() public {
        vm.expectRevert(UnderwaterPlates.PriceTooHigh.selector);
        new UnderwaterPlates(
            owner, address(pool), treasury, bytes32(0), PRICE_CEILING + 1, WL_PRICE, RESERVE, mintCloses
        );

        vm.expectRevert(UnderwaterPlates.PriceTooHigh.selector);
        new UnderwaterPlates(
            owner, address(pool), treasury, bytes32(0), PRICE, PRICE_CEILING + 1, RESERVE, mintCloses
        );
    }

    function test_constructorSetsTheOpeningLimits() public view {
        assertEq(plates.price(), PRICE);
        assertEq(plates.wlPrice(), WL_PRICE);
        assertEq(plates.maxPerTx(), 22);
        assertEq(plates.maxPerWallet(), 22);
        assertEq(plates.merkleRoot(), bytes32(0), "no allowlist until one is set");
        assertFalse(plates.publicOpen(), "public phase starts shut");
    }

    function test_constructorDeploysTrophyOwnedByNobody() public view {
        assertEq(trophy.plates(), address(plates), "plates is the only minter");
        assertEq(trophy.totalSupply(), 0);
    }

    // ─── Trait table and seal ─────────────────────────────────────────────

    function test_commitIsOwnerOnly() public {
        uint256[] memory chunk = new uint256[](1);
        vm.expectRevert(Owned.NotOwner.selector);
        vm.prank(alice);
        plates.commit(0, chunk);
    }

    function test_commitRejectsWritePastEnd() public {
        uint256[] memory chunk = new uint256[](2);
        vm.expectRevert(UnderwaterPlates.OutOfRange.selector);
        vm.prank(owner);
        plates.commit(TABLE_WORDS - 1, chunk);
    }

    function test_commitStoresWords() public {
        _commit();
        assertEq(plates.tableWord(0), table[0]);
        assertEq(plates.tableWord(TABLE_WORDS - 1), table[TABLE_WORDS - 1]);
    }

    function test_tableWordRejectsOutOfRange() public {
        vm.expectRevert(UnderwaterPlates.OutOfRange.selector);
        plates.tableWord(TABLE_WORDS);
    }

    function test_sealRejectsATableThatDoesNotHashToProvenance() public {
        _commit();

        // One nibble different in one plate out of 2222.
        uint256[] memory tamper = new uint256[](1);
        tamper[0] = table[7] ^ 1;
        vm.prank(owner);
        plates.commit(7, tamper);

        vm.expectRevert(UnderwaterPlates.ProvenanceMismatch.selector);
        vm.prank(owner);
        plates.seal();
        assertFalse(plates.isSealed());
    }

    function test_sealRejectsAnEmptyTable() public {
        vm.expectRevert(UnderwaterPlates.ProvenanceMismatch.selector);
        vm.prank(owner);
        plates.seal();
    }

    function test_sealIsOwnerOnly() public {
        _commit();
        vm.expectRevert(Owned.NotOwner.selector);
        vm.prank(alice);
        plates.seal();
    }

    function test_sealMintsTheReserveToTreasury() public {
        _open();

        assertTrue(plates.isSealed());
        assertEq(plates.minted(), RESERVE);
        assertEq(plates.balanceOf(treasury), RESERVE);
        assertEq(plates.ownerOf(1), treasury);
        assertEq(plates.ownerOf(RESERVE), treasury);
    }

    function test_sealTwiceReverts() public {
        _open();
        vm.expectRevert(UnderwaterPlates.AlreadySealed.selector);
        vm.prank(owner);
        plates.seal();
    }

    function test_commitAfterSealReverts() public {
        _open();
        uint256[] memory chunk = new uint256[](1);
        vm.expectRevert(UnderwaterPlates.AlreadySealed.selector);
        vm.prank(owner);
        plates.commit(0, chunk);
    }

    // ─── Mint ─────────────────────────────────────────────────────────────

    function test_mintBeforeSealReverts() public {
        // The public phase can be opened before the table is sealed; the seal is
        // still what gates minting, and this proves the two checks are independent.
        vm.prank(owner);
        plates.openPublicMint();

        vm.expectRevert(UnderwaterPlates.NotSealed.selector);
        vm.prank(alice);
        plates.mint{value: PRICE}(1);
    }

    function test_mintBeforeThePublicPhaseOpensReverts() public {
        _sealed();

        vm.expectRevert(UnderwaterPlates.PublicMintClosed.selector);
        vm.prank(alice);
        plates.mint{value: PRICE}(1);

        vm.prank(owner);
        plates.openPublicMint();
        _mintTo(alice, 1);
        assertEq(plates.balanceOf(alice), 1);
    }

    function test_mintAssignsSequentialIdsAfterTheReserve() public {
        _open();
        uint256 first = _mintTo(alice, 3);

        assertEq(first, RESERVE + 1);
        assertEq(plates.balanceOf(alice), 3);
        assertEq(plates.ownerOf(RESERVE + 1), alice);
        assertEq(plates.ownerOf(RESERVE + 3), alice);
        assertEq(plates.minted(), RESERVE + 3);
    }

    function test_mintRequiresExactPayment() public {
        _open();

        vm.expectRevert(UnderwaterPlates.WrongPayment.selector);
        vm.prank(alice);
        plates.mint{value: PRICE * 2 - 1}(2);

        vm.expectRevert(UnderwaterPlates.WrongPayment.selector);
        vm.prank(alice);
        plates.mint{value: PRICE * 2 + 1}(2);
    }

    function test_mintRejectsZeroAndOversizedQuantity() public {
        _open();

        vm.expectRevert(UnderwaterPlates.TooManyAtOnce.selector);
        vm.prank(alice);
        plates.mint(0);

        uint256 over = plates.maxPerTx() + 1;
        vm.expectRevert(UnderwaterPlates.TooManyAtOnce.selector);
        vm.prank(alice);
        plates.mint{value: PRICE * over}(over);
    }

    function test_mintClosesAtTheDeadline() public {
        _open();
        vm.warp(mintCloses);
        _mintTo(alice, 1); // the deadline itself is still open

        vm.warp(mintCloses + 1);
        vm.expectRevert(UnderwaterPlates.MintClosed.selector);
        vm.prank(alice);
        plates.mint{value: PRICE}(1);
    }

    function test_mintChecksTheRecipientCanHoldERC721() public {
        _open();

        BadReceiver bad = new BadReceiver();
        vm.deal(address(bad), 1 ether);
        vm.expectRevert(ERC721.UnsafeRecipient.selector);
        vm.prank(address(bad));
        plates.mint{value: PRICE}(1);

        GoodReceiver good = new GoodReceiver();
        vm.deal(address(good), 1 ether);
        vm.prank(address(good));
        plates.mint{value: PRICE}(1);
        assertEq(plates.balanceOf(address(good)), 1);
    }

    /// @dev `_safeMint` hands control to the recipient before the mint loop is
    ///      done, which is the only window a buyer has to run code mid-mint.
    function test_mintCannotBeReenteredFromTheRecipientCallback() public {
        _open();

        ReentrantReceiver attacker = new ReentrantReceiver(address(plates), PRICE);
        vm.deal(address(attacker), 1 ether);

        vm.expectRevert(ReentrancyGuard.Reentrancy.selector);
        attacker.attack{value: PRICE}();
        assertEq(plates.minted(), RESERVE, "nothing minted");
    }

    function test_mintSellsOutAtExactlySupply() public {
        _open();

        uint256 perTx = plates.maxPerTx();
        uint256 remaining = SUPPLY - RESERVE;
        vm.deal(alice, PRICE * remaining + 1 ether);

        while (remaining > 0) {
            uint256 qty = remaining < perTx ? remaining : perTx;
            _mintTo(alice, qty);
            remaining -= qty;
        }

        assertEq(plates.minted(), SUPPLY);
        assertEq(plates.balanceOf(alice), SUPPLY - RESERVE);

        vm.expectRevert(UnderwaterPlates.SoldOut.selector);
        vm.prank(alice);
        plates.mint{value: PRICE}(1);

        // Selling out lets the reveal happen without waiting for the deadline.
        vm.roll(block.number + 1);
        plates.reveal();
        assertTrue(plates.isRevealed());
    }

    function test_withdrawForwardsEverythingToTreasury() public {
        _open();
        _mintTo(alice, 5);

        uint256 before = treasury.balance;
        vm.prank(bob); // permissionless, and cannot be redirected
        plates.withdraw();

        assertEq(treasury.balance - before, PRICE * 5);
        assertEq(address(plates).balance, 0);
    }

    // ─── Allowlist ────────────────────────────────────────────────────────

    function test_whitelistMintNeedsARoot() public {
        _sealed();

        vm.expectRevert(UnderwaterPlates.NoWhitelist.selector);
        vm.prank(alice);
        plates.mintWhitelist{value: WL_PRICE}(1, _proof(alice));
    }

    /// @dev The one that matters: with no root set, `merkleRoot` is zero and an
    ///      empty proof leaves `computed == leaf`, so a naive verifier would let
    ///      nobody in — but a *zero leaf* against a zero root would pass. The
    ///      explicit `NoWhitelist` check is what closes that, and this pins it.
    function test_anEmptyProofDoesNotOpenTheAllowlist() public {
        _sealed();

        bytes32[] memory none = new bytes32[](0);
        vm.expectRevert(UnderwaterPlates.NoWhitelist.selector);
        vm.prank(bob);
        plates.mintWhitelist{value: WL_PRICE}(1, none);
    }

    function test_whitelistMintAcceptsAMemberAtTheAllowlistPrice() public {
        _openWhitelist();

        uint256 first = plates.minted() + 1;
        vm.expectEmit(true, false, false, true, address(plates));
        emit UnderwaterPlates.WhitelistMinted(alice, 2);
        vm.prank(alice);
        plates.mintWhitelist{value: WL_PRICE * 2}(2, _proof(alice));

        assertEq(plates.balanceOf(alice), 2);
        assertEq(plates.ownerOf(first), alice);
        assertEq(plates.wlMinted(), 2);
        assertEq(plates.wlClaimed(alice), 2);
        assertEq(address(plates).balance, WL_PRICE * 2, "charged the allowlist price");
    }

    /// @dev Every member proves, including the one promoted twice up the odd
    ///      layers, whose proof is a single sibling rather than the full depth.
    function test_everyMemberOfTheTreeCanProve() public {
        _openWhitelist();

        address[5] memory members = [alice, hunter, carol, dave, erin];
        for (uint256 i; i < members.length; ++i) {
            _mintWhitelist(members[i], 1);
            assertEq(plates.balanceOf(members[i]), 1, "member could not prove");
        }
        assertEq(plates.wlMinted(), 5);
    }

    function test_whitelistRejectsANonMember() public {
        _openWhitelist();

        bytes32[] memory none = new bytes32[](0);
        vm.expectRevert(UnderwaterPlates.NotWhitelisted.selector);
        vm.prank(bob);
        plates.mintWhitelist{value: WL_PRICE}(1, none);
    }

    /// @dev A proof is bound to `msg.sender`, not passed in, so a valid proof is
    ///      worthless in anybody else's hands.
    function test_aMembersProofDoesNotWorkForSomeoneElse() public {
        _openWhitelist();

        bytes32[] memory aliceProof = _proof(alice);
        vm.expectRevert(UnderwaterPlates.NotWhitelisted.selector);
        vm.prank(bob);
        plates.mintWhitelist{value: WL_PRICE}(1, aliceProof);

        // Nor for another member: the leaf is the sender's, not the proof's.
        vm.expectRevert(UnderwaterPlates.NotWhitelisted.selector);
        vm.prank(carol);
        plates.mintWhitelist{value: WL_PRICE}(1, aliceProof);
    }

    function test_whitelistMintRequiresTheAllowlistPriceExactly() public {
        _openWhitelist();
        bytes32[] memory proof = _proof(alice);

        vm.expectRevert(UnderwaterPlates.WrongPayment.selector);
        vm.prank(alice);
        plates.mintWhitelist{value: PRICE}(1, proof);

        vm.expectRevert(UnderwaterPlates.WrongPayment.selector);
        vm.prank(alice);
        plates.mintWhitelist{value: WL_PRICE - 1}(1, proof);
    }

    function test_whitelistMintNeedsTheSealAndRespectsTheDeadline() public {
        // A root may be set before the table is sealed; the seal still gates it.
        vm.prank(owner);
        plates.setMerkleRoot(wlRoot);

        vm.expectRevert(UnderwaterPlates.NotSealed.selector);
        vm.prank(alice);
        plates.mintWhitelist{value: WL_PRICE}(1, _proof(alice));

        _sealed();
        vm.warp(mintCloses + 1);
        vm.expectRevert(UnderwaterPlates.MintClosed.selector);
        vm.prank(alice);
        plates.mintWhitelist{value: WL_PRICE}(1, _proof(alice));
    }

    function test_whitelistEnforcesThePerWalletCap() public {
        _openWhitelist();

        uint256 cap = plates.maxPerWallet();
        _mintWhitelist(alice, cap - 1);
        _mintWhitelist(alice, 1);
        assertEq(plates.wlClaimed(alice), cap);

        bytes32[] memory proof = _proof(alice);
        vm.expectRevert(UnderwaterPlates.WalletLimit.selector);
        vm.prank(alice);
        plates.mintWhitelist{value: WL_PRICE}(1, proof);

        // The cap is per address, not global: another member is unaffected.
        _mintWhitelist(hunter, 1);
        assertEq(plates.wlMinted(), cap + 1);
    }

    /// @dev The phase cap. Filling a 2000-plate phase under the 222 per-wallet
    ///      ceiling takes ceil(2000 / 222) = 10 wallets, more than the shared
    ///      five-member tree holds, so this test builds its own tree sized from
    ///      `WL_ALLOCATION` — every other allowlist test keeps the setUp tree. What
    ///      is under test is `WL_ALLOCATION`, not how many wallets it took to reach.
    function test_whitelistAllocationCapsThePhase() public {
        uint256 need = (WL_ALLOCATION + LIMIT_CEILING - 1) / LIMIT_CEILING;
        address[] memory members = new address[](need);
        for (uint256 i; i < need; ++i) {
            members[i] = address(uint160(0xA11CE + i));
            vm.deal(members[i], 100 ether);
        }
        delete wlTree;
        wlRoot = _buildWhitelist(members);

        _openWhitelist();
        vm.startPrank(owner);
        plates.setMaxPerTx(LIMIT_CEILING);
        plates.setMaxPerWallet(LIMIT_CEILING);
        vm.stopPrank();

        // Every wallet but the last takes the ceiling; the last takes the remainder.
        uint256 full = need - 1;
        for (uint256 i; i < full; ++i) {
            _mintWhitelist(members[i], LIMIT_CEILING);
        }
        assertEq(plates.wlMinted(), LIMIT_CEILING * full, "the first wallets are at the ceiling");

        uint256 left = WL_ALLOCATION - LIMIT_CEILING * full;
        address last = members[need - 1];
        // One past the phase cap reverts, even though this wallet is under its own.
        vm.expectRevert(UnderwaterPlates.WhitelistSoldOut.selector);
        vm.prank(last);
        plates.mintWhitelist{value: WL_PRICE * (left + 1)}(left + 1, _proof(last));

        _mintWhitelist(last, left);
        assertEq(plates.wlMinted(), WL_ALLOCATION, "the phase is exactly full");

        vm.expectRevert(UnderwaterPlates.WhitelistSoldOut.selector);
        vm.prank(members[0]);
        plates.mintWhitelist{value: WL_PRICE}(1, _proof(members[0]));
    }

    /// @dev `WL_ALLOCATION` bounds a phase, not a set of plates. Whatever the
    ///      allowlist leaves has to remain mintable, or the collection could never
    ///      sell out and `reveal` would wait on the deadline every time.
    function test_whatTheAllowlistLeavesRollsIntoThePublicPhase() public {
        _openWhitelist();
        _mintWhitelist(alice, 1);

        vm.prank(owner);
        plates.openPublicMint();

        uint256 perTx = plates.maxPerTx();
        uint256 remaining = SUPPLY - plates.minted();
        vm.deal(bob, PRICE * remaining + 1 ether);

        while (remaining > 0) {
            uint256 qty = remaining < perTx ? remaining : perTx;
            _mintTo(bob, qty);
            remaining -= qty;
        }

        assertEq(plates.minted(), SUPPLY, "1999 unused allowlist plates were mintable");
        assertEq(plates.wlMinted(), 1);
    }

    /// @dev An allowlist spot is a right to the discounted price. Opening the
    ///      public phase does not take it away from whoever was slow.
    function test_theAllowlistStaysOpenAfterThePublicPhaseOpens() public {
        _openWhitelist();
        vm.prank(owner);
        plates.openPublicMint();

        _mintTo(bob, 1);
        _mintWhitelist(alice, 1);

        assertEq(address(plates).balance, PRICE + WL_PRICE, "each phase paid its own price");
    }

    function test_changingTheRootDoesNotClawBackWhatWasClaimed() public {
        _openWhitelist();
        _mintWhitelist(alice, 3);

        // A tree alice is not in. What it contains does not matter; that her leaf
        // no longer proves against it does.
        vm.prank(owner);
        plates.setMerkleRoot(keccak256("a different allowlist"));

        bytes32[] memory proof = _proof(alice);
        vm.expectRevert(UnderwaterPlates.NotWhitelisted.selector);
        vm.prank(alice);
        plates.mintWhitelist{value: WL_PRICE}(1, proof);

        assertEq(plates.balanceOf(alice), 3, "plates already minted are hers");
        assertEq(plates.wlClaimed(alice), 3, "and still count against her cap");
    }

    // ─── Mutable launch parameters ────────────────────────────────────────

    function test_setPriceMovesWhatTheNextMintCosts() public {
        _open();

        vm.expectEmit(false, false, false, true, address(plates));
        emit UnderwaterPlates.PriceSet(0.05 ether);
        vm.prank(owner);
        plates.setPrice(0.05 ether);
        assertEq(plates.price(), 0.05 ether);

        vm.expectRevert(UnderwaterPlates.WrongPayment.selector);
        vm.prank(alice);
        plates.mint{value: PRICE}(1);

        vm.prank(alice);
        plates.mint{value: 0.05 ether}(1);
        assertEq(plates.balanceOf(alice), 1);
    }

    /// @dev The claim in the contract's own doc comment: because payment must be
    ///      exact, a price raised out from under a pending mint makes it revert
    ///      rather than quietly charging more than the buyer agreed to.
    function test_aPriceRaisedUnderAPendingMintRevertsRatherThanOvercharging() public {
        _open();
        uint256 quoted = plates.price();
        uint256 before = alice.balance;

        vm.prank(owner);
        plates.setPrice(quoted * 2);

        vm.expectRevert(UnderwaterPlates.WrongPayment.selector);
        vm.prank(alice);
        plates.mint{value: quoted}(1);

        assertEq(alice.balance, before, "not a wei taken");
        assertEq(plates.balanceOf(alice), 0);
    }

    function test_setWhitelistPriceRepegsOnlyTheAllowlist() public {
        _openWhitelist();

        vm.prank(owner);
        plates.setWhitelistPrice(0.004 ether);
        assertEq(plates.wlPrice(), 0.004 ether);
        assertEq(plates.price(), PRICE, "the public price did not move");

        vm.prank(alice);
        plates.mintWhitelist{value: 0.004 ether}(1, _proof(alice));
        assertEq(plates.balanceOf(alice), 1);
    }

    function test_bothPricesAreBoundedByTheCeiling() public {
        vm.startPrank(owner);

        vm.expectRevert(UnderwaterPlates.PriceTooHigh.selector);
        plates.setPrice(PRICE_CEILING + 1);
        vm.expectRevert(UnderwaterPlates.PriceTooHigh.selector);
        plates.setWhitelistPrice(PRICE_CEILING + 1);

        plates.setPrice(PRICE_CEILING);
        plates.setWhitelistPrice(PRICE_CEILING);
        vm.stopPrank();

        assertEq(plates.price(), PRICE_CEILING, "the ceiling itself is allowed");
        assertEq(plates.wlPrice(), PRICE_CEILING);
    }

    /// @dev Zero is deliberately legal. A free phase is a launch choice, and
    ///      forbidding it in the setter would be an opinion rather than a bound.
    function test_aPriceOfZeroMintsForFree() public {
        _open();
        vm.prank(owner);
        plates.setPrice(0);

        vm.prank(alice);
        plates.mint{value: 0}(1);
        assertEq(plates.balanceOf(alice), 1);
    }

    function test_setMaxPerTxBindsBothPhases() public {
        _openWhitelist();
        vm.prank(owner);
        plates.openPublicMint();

        vm.expectEmit(false, false, false, true, address(plates));
        emit UnderwaterPlates.MaxPerTxSet(3);
        vm.prank(owner);
        plates.setMaxPerTx(3);

        vm.expectRevert(UnderwaterPlates.TooManyAtOnce.selector);
        vm.prank(bob);
        plates.mint{value: PRICE * 4}(4);

        bytes32[] memory proof = _proof(alice);
        vm.expectRevert(UnderwaterPlates.TooManyAtOnce.selector);
        vm.prank(alice);
        plates.mintWhitelist{value: WL_PRICE * 4}(4, proof);

        _mintTo(bob, 3);
        _mintWhitelist(alice, 3);
        assertEq(plates.minted(), RESERVE + 6);
    }

    function test_setMaxPerWalletBindsTheAllowlistAndCannotUnmint() public {
        _openWhitelist();
        vm.prank(owner);
        plates.setMaxPerWallet(2);

        _mintWhitelist(alice, 2);
        bytes32[] memory proof = _proof(alice);
        vm.expectRevert(UnderwaterPlates.WalletLimit.selector);
        vm.prank(alice);
        plates.mintWhitelist{value: WL_PRICE}(1, proof);

        // Lowering it below what alice already took blocks her from minting more
        // and takes nothing back.
        vm.prank(owner);
        plates.setMaxPerWallet(1);
        vm.expectRevert(UnderwaterPlates.WalletLimit.selector);
        vm.prank(alice);
        plates.mintWhitelist{value: WL_PRICE}(1, proof);
        assertEq(plates.balanceOf(alice), 2);
    }

    function test_limitsAreBoundedAndCannotBeZeroed() public {
        vm.startPrank(owner);

        vm.expectRevert(UnderwaterPlates.LimitTooHigh.selector);
        plates.setMaxPerTx(0);
        vm.expectRevert(UnderwaterPlates.LimitTooHigh.selector);
        plates.setMaxPerTx(LIMIT_CEILING + 1);
        vm.expectRevert(UnderwaterPlates.LimitTooHigh.selector);
        plates.setMaxPerWallet(0);
        vm.expectRevert(UnderwaterPlates.LimitTooHigh.selector);
        plates.setMaxPerWallet(LIMIT_CEILING + 1);

        plates.setMaxPerTx(LIMIT_CEILING);
        plates.setMaxPerWallet(LIMIT_CEILING);
        vm.stopPrank();

        assertEq(plates.maxPerTx(), LIMIT_CEILING);
        assertEq(plates.maxPerWallet(), LIMIT_CEILING);
    }

    /// @dev No matching close, so a buyer part-way through a mint cannot have the
    ///      phase shut under them.
    function test_openPublicMintIsOneWay() public {
        _sealed();
        vm.prank(owner);
        plates.openPublicMint();
        assertTrue(plates.publicOpen());

        vm.prank(owner);
        plates.openPublicMint(); // idempotent, not a revert
        assertTrue(plates.publicOpen());
    }

    function test_everyLaunchParameterIsOwnerOnly() public {
        vm.startPrank(alice);

        vm.expectRevert(Owned.NotOwner.selector);
        plates.setPrice(0);
        vm.expectRevert(Owned.NotOwner.selector);
        plates.setWhitelistPrice(0);
        vm.expectRevert(Owned.NotOwner.selector);
        plates.setMaxPerTx(1);
        vm.expectRevert(Owned.NotOwner.selector);
        plates.setMaxPerWallet(1);
        vm.expectRevert(Owned.NotOwner.selector);
        plates.setMerkleRoot(wlRoot);
        vm.expectRevert(Owned.NotOwner.selector);
        plates.openPublicMint();

        vm.stopPrank();
    }

    // ─── Reveal ───────────────────────────────────────────────────────────

    function test_traitsAreUnreadableBeforeReveal() public {
        _open();
        _mintTo(alice, 1);

        vm.expectRevert(UnderwaterPlates.NotRevealed.selector);
        plates.traitsOf(RESERVE + 1);
    }

    function test_revealBeforeSealReverts() public {
        vm.expectRevert(UnderwaterPlates.NotSealed.selector);
        plates.reveal();
    }

    function test_revealWhileMintIsOpenReverts() public {
        _open();
        _mintTo(alice, 1);

        vm.expectRevert(UnderwaterPlates.MintStillOpen.selector);
        plates.reveal();
    }

    function test_revealIsPermissionlessOnceTheWindowCloses() public {
        _open();
        _mintTo(alice, 1);

        vm.warp(mintCloses + 1);
        vm.roll(block.number + 64);
        vm.prank(bob); // not the owner, not a holder
        plates.reveal();

        assertTrue(plates.isRevealed());
        assertLt(plates.revealOffset(), SUPPLY);
    }

    function test_revealTwiceReverts() public {
        _open();
        _revealByDeadline();

        vm.expectRevert(UnderwaterPlates.AlreadyRevealed.selector);
        plates.reveal();
    }

    function test_traitsMatchTheCommittedTable() public {
        _open();
        _revealByDeadline();

        // Guard the test itself: at offset 0 the mapping is the identity and this
        // would pass without exercising the shift or the wraparound.
        assertGt(plates.revealOffset(), 0, "offset must actually move the plates");

        uint256[8] memory ids = [uint256(1), 2, 7, 23, 100, 1111, 2221, SUPPLY];
        for (uint256 i; i < ids.length; ++i) {
            assertEq(plates.traitsOf(ids[i]), _expectedTraits(ids[i]), "packed traits");
        }
    }

    function test_traitOfDecomposesThePackedWord() public {
        _open();
        _revealByDeadline();

        uint256 id = 447;
        uint256 packed = plates.traitsOf(id);
        uint256 rebuilt;
        for (uint256 c; c < CATEGORIES; ++c) {
            uint256 index = plates.traitOf(id, c);
            assertLt(index, _optionCount(c), "index within the category");
            rebuilt |= index << (c * TRAIT_BITS);
        }
        assertEq(rebuilt, packed, "nibbles reassemble the plate");
    }

    function test_traitOfRejectsUnknownCategory() public {
        _open();
        _revealByDeadline();

        vm.expectRevert(UnderwaterPlates.OutOfRange.selector);
        plates.traitOf(1, CATEGORIES);
    }

    function test_traitsRejectIdsOutsideTheCollection() public {
        _open();
        _revealByDeadline();

        vm.expectRevert(UnderwaterPlates.OutOfRange.selector);
        plates.traitsOf(0);

        vm.expectRevert(UnderwaterPlates.OutOfRange.selector);
        plates.traitsOf(SUPPLY + 1);
    }

    /// @dev The offset must permute plate numbers onto table slots, not collapse
    ///      any two onto one — otherwise two plates share a trait set and the
    ///      published rarity table is wrong.
    function test_slotMappingIsABijectionOverTheWholeCollection() public {
        _open();
        _revealByDeadline();

        uint256 offset = plates.revealOffset();
        bool[SUPPLY] memory seen;
        for (uint256 id = 1; id <= SUPPLY; ++id) {
            uint256 slot = (id - 1 + offset) % SUPPLY;
            assertFalse(seen[slot], "slot claimed twice");
            seen[slot] = true;
        }
    }

    // ─── Diving ───────────────────────────────────────────────────────────

    function test_diveIsHolderOnly() public {
        _open();
        uint256 id = _mintTo(alice, 1);

        vm.expectRevert(UnderwaterPlates.NotHolder.selector);
        vm.prank(bob);
        plates.dive(id);
    }

    function test_diveTracksTheCallersOwnPositionOnly() public {
        _open();
        uint256 id = _mintTo(alice, 1);

        vm.prank(alice);
        plates.dive(id);

        (address position, uint40 since,, uint8 scars) = plates.dives(id);
        assertEq(position, alice, "never a parameter");
        assertEq(since, uint40(block.timestamp));
        assertEq(scars, 0);
    }

    function test_diveTwiceReverts() public {
        _open();
        uint256 id = _diving(alice, 2e18);

        vm.expectRevert(UnderwaterPlates.AlreadyDiving.selector);
        vm.prank(alice);
        plates.dive(id);
    }

    function test_surfaceDetachesThePosition() public {
        _open();
        uint256 id = _diving(alice, 2e18);

        vm.prank(alice);
        plates.surface(id);

        (address position, uint40 since,,) = plates.dives(id);
        assertEq(position, address(0));
        assertEq(since, 0);
        assertEq(plates.healthFactorOf(id), plates.DRY_DOCK());
    }

    function test_surfaceIsHolderOnlyAndRequiresADive() public {
        _open();
        uint256 id = _mintTo(alice, 1);

        vm.expectRevert(UnderwaterPlates.NotDiving.selector);
        vm.prank(alice);
        plates.surface(id);

        vm.prank(alice);
        plates.dive(id);

        vm.expectRevert(UnderwaterPlates.NotHolder.selector);
        vm.prank(bob);
        plates.surface(id);
    }

    /// @dev Otherwise a seller keeps a plate pointed at their own position and can
    ///      drown art they no longer own.
    function test_transferSurfacesThePlate() public {
        _open();
        uint256 id = _diving(alice, 1.2e18);

        vm.prank(alice);
        plates.transferFrom(alice, bob, id);

        (address position,,,) = plates.dives(id);
        assertEq(position, address(0), "auto-surfaced on transfer");
        assertEq(plates.healthFactorOf(id), plates.DRY_DOCK());

        // And the new holder can attach their own.
        pool.setHealthFactor(bob, 3e18);
        vm.prank(bob);
        plates.dive(id);
        assertEq(plates.healthFactorOf(id), 3e18);
    }

    function test_healthFactorIsDryDockUntilADiveStarts() public {
        _open();
        uint256 id = _mintTo(alice, 1);
        assertEq(plates.healthFactorOf(id), type(uint256).max);
    }

    function test_healthFactorReadsThePool() public {
        _open();
        uint256 id = _diving(alice, 1.37e18);
        assertEq(plates.healthFactorOf(id), 1.37e18);

        pool.setHealthFactor(alice, 0.5e18);
        assertEq(plates.healthFactorOf(id), 0.5e18, "live, not snapshotted");
    }

    // ─── Scars ────────────────────────────────────────────────────────────

    function test_scarRequiresAnExistingPlate() public {
        _open();
        vm.expectRevert(ERC721.NotMinted.selector);
        plates.scar(9999);
    }

    function test_scarRequiresADive() public {
        _open();
        uint256 id = _mintTo(alice, 1);

        vm.expectRevert(UnderwaterPlates.NotDiving.selector);
        plates.scar(id);
    }

    function test_scarRequiresTheHealthFactorToBeLow() public {
        _open();
        uint256 id = _diving(alice, plates.SCAR_HF());

        vm.expectRevert(UnderwaterPlates.StillAfloat.selector);
        plates.scar(id);
    }

    /// @dev Regression: a cooldown compared against an unset `lastScar` blocks the
    ///      very first scar, which is the only one every scarred plate has.
    function test_firstScarLandsImmediately() public {
        _open();
        uint256 id = _diving(alice, 1.1e18);

        vm.prank(bob); // permissionless: the holder does not get to veto the record
        plates.scar(id);

        (,,, uint8 scars) = plates.dives(id);
        assertEq(scars, 1);
    }

    function test_scarIsRateLimited() public {
        _open();
        uint256 id = _diving(alice, 1.1e18);
        plates.scar(id);

        vm.expectRevert(UnderwaterPlates.ScarTooSoon.selector);
        plates.scar(id);

        vm.warp(block.timestamp + plates.SCAR_COOLDOWN());
        plates.scar(id);

        (,,, uint8 scars) = plates.dives(id);
        assertEq(scars, 2);
    }

    function test_scarsStopAtTheCap() public {
        _open();
        uint256 id = _diving(alice, 1.1e18);

        uint256 cap = plates.MAX_SCARS();
        for (uint256 i; i < cap; ++i) {
            plates.scar(id);
            vm.warp(block.timestamp + plates.SCAR_COOLDOWN());
        }

        vm.expectRevert(UnderwaterPlates.MaxScars.selector);
        plates.scar(id);

        (,,, uint8 scars) = plates.dives(id);
        assertEq(scars, cap);
    }

    function test_scarsSurviveSurfacingAndSelling() public {
        _open();
        uint256 id = _diving(alice, 1.1e18);
        plates.scar(id);

        vm.startPrank(alice);
        plates.surface(id);
        plates.transferFrom(alice, bob, id);
        vm.stopPrank();

        (,,, uint8 scars) = plates.dives(id);
        assertEq(scars, 1, "the paper remembers");
    }

    // ─── Drown ────────────────────────────────────────────────────────────

    function test_drownRequiresADive() public {
        _open();
        uint256 id = _mintTo(alice, 1);

        vm.expectRevert(UnderwaterPlates.NotDiving.selector);
        plates.drown(id);
    }

    function test_drownRejectsASolventPosition() public {
        _open();
        uint256 id = _diving(alice, plates.DROWN_HF() + 1);

        vm.expectRevert(UnderwaterPlates.StillAfloat.selector);
        plates.drown(id);
    }

    function test_drownBurnsThePlateAndMintsTheTrophy() public {
        _open();
        uint256 id = _diving(alice, 0.87e18);
        uint256 balanceBefore = plates.balanceOf(alice);

        vm.prank(hunter);
        uint256 trophyId = plates.drown(id);

        assertEq(trophyId, 1);
        assertEq(plates.balanceOf(alice), balanceBefore - 1, "plate burned");
        vm.expectRevert(ERC721.NotMinted.selector);
        plates.ownerOf(id);

        assertEq(trophy.ownerOf(trophyId), hunter, "the kill goes to the caller");
        (uint16 plate, uint64 block_, uint128 hf, address who) = trophy.kills(trophyId);
        assertEq(uint256(plate), id);
        assertEq(block_, uint64(block.number));
        assertEq(hf, 0.87e18);
        assertEq(who, hunter);
    }

    function test_drownAtExactlyOneIsAllowed() public {
        _open();
        uint256 id = _diving(alice, plates.DROWN_HF());

        vm.prank(hunter);
        plates.drown(id);
        assertEq(trophy.balanceOf(hunter), 1);
    }

    function test_drownedPlateCannotBeDrownedTwice() public {
        _open();
        uint256 id = _diving(alice, 0.9e18);

        vm.prank(hunter);
        plates.drown(id);

        vm.expectRevert(ERC721.NotMinted.selector);
        plates.drown(id);
        assertEq(trophy.totalSupply(), 1);
    }

    function test_burningSurfacesThePlate() public {
        _open();
        uint256 id = _diving(alice, 0.9e18);

        vm.prank(hunter);
        plates.drown(id);

        (address position,,,) = plates.dives(id);
        assertEq(position, address(0));
    }

    function test_trophyCannotBeMintedByAnyoneElse() public {
        vm.expectRevert(UnderwaterTrophy.OnlyPlates.selector);
        vm.prank(hunter);
        trophy.record(1, hunter, 1e18);
    }

    // ─── Metadata ─────────────────────────────────────────────────────────

    function test_tokenURIPassesLiveStateToTheRenderer() public {
        _open();
        uint256 id = _diving(alice, 1.1e18);
        plates.scar(id);
        _revealByDeadline();

        assertEq(
            plates.tokenURI(id),
            string.concat(
                "id=",
                vm.toString(id),
                ";traits=",
                vm.toString(plates.traitsOf(id)),
                ";hf=",
                vm.toString(uint256(1.1e18)),
                ";scars=1;revealed=1"
            )
        );
    }

    function test_tokenURIBeforeRevealCarriesNoTraits() public {
        _open();
        uint256 id = _mintTo(alice, 1);

        assertEq(
            plates.tokenURI(id),
            string.concat(
                "id=", vm.toString(id), ";traits=0;hf=", vm.toString(type(uint256).max), ";scars=0;revealed=0"
            )
        );
    }

    function test_tokenURIRejectsAPlateThatDoesNotExist() public {
        _open();
        vm.expectRevert(ERC721.NotMinted.selector);
        plates.tokenURI(RESERVE + 1);
    }

    function test_royaltyGoesToTreasuryAtFivePercent() public view {
        (address receiver, uint256 amount) = plates.royaltyInfo(1, 10 ether);
        assertEq(receiver, treasury);
        assertEq(amount, 0.5 ether);
    }

    function test_supportsTheInterfacesMarketplacesLookFor() public view {
        assertTrue(plates.supportsInterface(0x01ffc9a7), "ERC165");
        assertTrue(plates.supportsInterface(0x80ac58cd), "ERC721");
        assertTrue(plates.supportsInterface(0x5b5e139f), "ERC721Metadata");
        assertTrue(plates.supportsInterface(0x2a55205a), "ERC2981");
        assertFalse(plates.supportsInterface(0x780e9d63), "not enumerable");
        assertFalse(plates.supportsInterface(0xffffffff));
    }

    /// @dev Asserted here rather than read off `forge build --sizes`, which does
    ///      not list this contract for reasons that are not the contract's.
    function test_bothContractsFitTheDeployedCodeLimit() public view {
        assertLt(address(plates).code.length, 24_576, "EIP-170: plates");
        assertLt(address(trophy).code.length, 24_576, "EIP-170: trophy");
    }

    // ─── Renderer ─────────────────────────────────────────────────────────

    function test_setRendererIsOwnerOnly() public {
        vm.expectRevert(Owned.NotOwner.selector);
        vm.prank(alice);
        plates.setRenderer(address(renderer));
    }

    function test_setRendererRejectsZero() public {
        vm.expectRevert(Owned.ZeroAddress.selector);
        vm.prank(owner);
        plates.setRenderer(address(0));
    }

    function test_freezeRendererIsPermanent() public {
        MockRenderer next = new MockRenderer();

        vm.startPrank(owner);
        plates.setRenderer(address(next));
        plates.freezeRenderer();

        vm.expectRevert(UnderwaterPlates.RendererLocked.selector);
        plates.setRenderer(address(renderer));
        vm.stopPrank();

        assertEq(address(plates.renderer()), address(next));
        assertTrue(plates.rendererFrozen());
    }

    function test_freezeRendererIsOwnerOnly() public {
        vm.expectRevert(Owned.NotOwner.selector);
        vm.prank(alice);
        plates.freezeRenderer();
    }
}
