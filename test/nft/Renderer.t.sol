// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterFigures} from "../../src/nft/art/UnderwaterFigures.sol";
import {UnderwaterMarks} from "../../src/nft/art/UnderwaterMarks.sol";
import {UnderwaterNames} from "../../src/nft/art/UnderwaterNames.sol";
import {UnderwaterRenderer} from "../../src/nft/art/UnderwaterRenderer.sol";
import {UnderwaterScenes} from "../../src/nft/art/UnderwaterScenes.sol";
import {RenderFixtures as F} from "./fixtures/RenderFixtures.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The renderer against `art/render.py`, a whole plate at a time.
///
/// @dev `Dissolve.t.sol` pins the arithmetic — the curve, the PRNG, the decimal
///      formatting. This pins the *bytes*: it deploys the four asset contracts and
///      the renderer, calls `render` exactly as `UnderwaterPlates.tokenURI` does,
///      and compares the token URI it gets back against what the Python renderer
///      produced from the same arguments.
///
///      Correct arithmetic composed in the wrong order is still the wrong picture,
///      and no amount of fuzzing the maths would catch it. These are the tests that
///      would.
///
///      Compared by `keccak256` rather than by string: a composed plate is 3-22 KB
///      of SVG base64'd inside the JSON, and 17 of them embedded as literals would
///      be 250 KB of unreadable blob in the fixture library. The two states drawn
///      from hand-written markup are *also* compared verbatim, below, so the rows
///      most likely to hold a transcription typo still print their bytes on failure.
contract RendererTest is Test {
    UnderwaterRenderer renderer;
    UnderwaterFigures figures;
    UnderwaterMarks marks;
    UnderwaterNames names;
    UnderwaterScenes scenes;

    function setUp() public {
        figures = new UnderwaterFigures();
        marks = new UnderwaterMarks();
        scenes = new UnderwaterScenes();
        names = new UnderwaterNames();
        renderer = new UnderwaterRenderer(figures, marks, scenes, names);
    }

    // ─── Whole plates, against the Python renderer ────────────────────────

    /// @dev One row per branch `render` can take. A failure pattern across them
    ///      localises the bug: every row failing is the shell or the defs, only the
    ///      blueprint rows failing is `_substrate`, only the scarred rows failing is
    ///      `_scars`.
    function test_platesMatchTheRenderer() public view {
        F.Plate[] memory cases = F.plates();

        for (uint256 i = 0; i < cases.length; ++i) {
            F.Plate memory c = cases[i];
            string memory uri = renderer.render(c.id, c.traits, c.healthFactor, c.scars, c.revealed);

            assertEq(keccak256(bytes(uri)), c.uri, string.concat("plate drifted: ", c.note));
        }
    }

    /// @dev The two states whose markup was transcribed into Solidity by hand rather
    ///      than generated from `art/traits/**`. Same bytes as two of the rows above;
    ///      this is a second look at them that prints a readable diff.
    function test_traitFreeStatesMatchVerbatim() public view {
        F.Verbatim[] memory cases = F.verbatim();

        for (uint256 i = 0; i < cases.length; ++i) {
            F.Verbatim memory c = cases[i];
            string memory uri = renderer.render(c.id, c.traits, c.healthFactor, c.scars, c.revealed);

            assertEq(uri, c.uri, string.concat("markup drifted: ", c.note));
        }
    }

    // ─── Properties the fixtures cannot state ─────────────────────────────

    /// @dev The reveal is the collection's fairness claim, and this is the renderer's
    ///      half of it: before it, every plate is the same picture. `tokenURI` passes
    ///      the real health factor and scars through even when unrevealed, so a plate
    ///      that varied with either would be leaking the reveal — which is exactly
    ///      what a sealed plate at a low health factor with scars would look like.
    ///
    ///      Fewer runs than the default: each one composes two whole plates, and the
    ///      property is not a narrow window a fuzzer has to search for — a renderer
    ///      that reads any of these three arguments while sealed fails on almost every
    ///      input, so 256 finds it as surely as 10,000 and the file stays runnable.
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_sealedPlatesRevealNothing(uint256 traits, uint256 hf, uint256 scars) public view {
        scars = bound(scars, 0, 8);

        assertEq(
            renderer.render(6, traits, hf, scars, false),
            renderer.render(6, 0, type(uint256).max, 0, false),
            "an unrevealed plate varied with what it was handed"
        );
    }

    /// @dev The plate number is the one thing a sealed tube does show, so two of them
    ///      must not be the same bytes. Guards against the check above being
    ///      satisfied by a renderer that ignores its arguments entirely.
    function test_sealedPlatesStillDifferByNumber() public view {
        assertNotEq(
            renderer.render(6, 0, type(uint256).max, 0, false),
            renderer.render(7, 0, type(uint256).max, 0, false),
            "sealed tubes lost their plate number"
        );
    }

    /// @dev The collection caps scars at 8 and the renderer clamps rather than
    ///      reverting, because a renderer that can make `tokenURI` throw is worse
    ///      than one that draws eight scars on a plate that somehow earned nine.
    ///
    ///      64 runs, not the default 10,000: this is the most expensive test in the
    ///      file at ~6.5M gas a run, and the interesting inputs are 8, 9 and "very
    ///      large" — everything above the cap takes the same branch, so the extra
    ///      9,936 runs buy nothing but wall-clock. The fixtures pin 8 and 9 exactly.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_scarsClampRatherThanRevert(uint256 scars) public view {
        scars = bound(scars, 8, type(uint256).max);

        assertEq(
            renderer.render(6, 0x32023d244, 1.2e18, scars, true),
            renderer.render(6, 0x32023d244, 1.2e18, 8, true),
            "scars past the cap changed the plate"
        );
    }

    /// @dev Liquidation is `hf <= WAD`, and the boundary is where an off-by-one
    ///      would put a drowned plate back in the water.
    function test_theDrownedBoundaryIsInclusive() public view {
        string memory atBoundary = renderer.render(6, 0x32023d244, 1e18, 3, true);
        string memory below = renderer.render(6, 0x32023d244, 1e18 - 1, 3, true);
        string memory above = renderer.render(6, 0x32023d244, 1e18 + 1, 3, true);

        assertEq(atBoundary, below, "exactly liquidated did not drown");
        assertNotEq(atBoundary, above, "one wei above liquidation drowned anyway");
    }

    /// @dev Every plate in the collection renders, at the health factor where the
    ///      most machinery is switched on. Traits come from the packed table rather
    ///      than being fuzzed, because a fuzzer would spend its time on the 6 of 16
    ///      nibble values that no category defines — those revert `BadIndex` by
    ///      design, and that is tested separately below.
    ///
    ///      Deliberately not asserting *what* comes out: the fixtures do that for 17
    ///      plates. This asserts only that nothing in the other 2205 combinations
    ///      reverts or returns nothing, which is the failure a marketplace would see
    ///      as a broken token.
    function test_everyTraitOptionRenders() public view {
        uint256[10] memory counts = [uint256(6), 5, 6, 15, 8, 5, 4, 4, 5, 4];

        for (uint256 category = 0; category < 10; ++category) {
            for (uint256 option = 0; option < counts[category]; ++option) {
                uint256 traits = option << (category * 4);
                string memory uri = renderer.render(6, traits, 1.45e18, 2, true);
                assertGt(bytes(uri).length, 1000, "a trait option rendered nothing");
            }
        }
    }

    /// @dev A nibble no category defines must revert rather than draw something. The
    ///      table can never produce one, so this is about a caller passing traits
    ///      directly — the renderer is public and takes them as an argument.
    function test_unknownTraitIndexReverts() public {
        // Substrate has 4 options; 15 is the widest nibble there is.
        vm.expectRevert();
        renderer.render(6, uint256(15) << 36, 1.45e18, 0, true);
    }

    // ─── Shape of the output ──────────────────────────────────────────────

    /// @dev What a wallet actually parses. Cheap to check and the first thing to
    ///      break if `_uri` is ever refactored.
    function test_theTokenUriIsBase64Json() public view {
        string memory uri = renderer.render(6, 0x32023d244, 2.6e18, 0, true);
        bytes memory b = bytes(uri);

        string memory prefix = "data:application/json;base64,";
        bytes memory want = bytes(prefix);
        assertGt(b.length, want.length, "uri is only a prefix");
        for (uint256 i = 0; i < want.length; ++i) {
            assertEq(b[i], want[i], "wrong data uri prefix");
        }

        // Base64's alphabet, plus the padding that can only appear at the end.
        for (uint256 i = want.length; i < b.length; ++i) {
            uint8 ch = uint8(b[i]);
            bool ok = (ch >= 0x41 && ch <= 0x5A) // A-Z
                || (ch >= 0x61 && ch <= 0x7A) // a-z
                || (ch >= 0x30 && ch <= 0x39) // 0-9
                || ch == 0x2B || ch == 0x2F // + /
                || ch == 0x3D; // =
            assertTrue(ok, "non-base64 byte in the token uri");
        }
    }

    /// @dev The renderer is reached through `eth_call`, so its runtime gas is paid by
    ///      nobody — but a marketplace indexer will give up on a call that costs more
    ///      than its node's cap. This is a smoke alarm, not a budget: it fires only if
    ///      a change makes a plate dramatically more expensive to draw.
    function test_aWholePlateStaysUnderTheCallGasCeiling() public view {
        uint256 before = gasleft();
        renderer.render(6, 0x32023d244, 1.05e18, 3, true);
        uint256 used = before - gasleft();

        assertLt(used, 50_000_000, "a plate got expensive enough to trip an eth_call cap");
    }

    // ─── Wiring ───────────────────────────────────────────────────────────

    function test_constructorRejectsMissingAssets() public {
        vm.expectRevert(UnderwaterRenderer.NoAssets.selector);
        new UnderwaterRenderer(UnderwaterFigures(address(0)), marks, scenes, names);

        vm.expectRevert(UnderwaterRenderer.NoAssets.selector);
        new UnderwaterRenderer(figures, UnderwaterMarks(address(0)), scenes, names);

        vm.expectRevert(UnderwaterRenderer.NoAssets.selector);
        new UnderwaterRenderer(figures, marks, UnderwaterScenes(address(0)), names);

        vm.expectRevert(UnderwaterRenderer.NoAssets.selector);
        new UnderwaterRenderer(figures, marks, scenes, UnderwaterNames(address(0)));
    }

    /// @dev EIP-170 caps runtime code at 24,576 B. The art is why the asset contracts
    ///      are separate at all, so the margin is worth failing on rather than
    ///      discovering at deploy time on a chain where it is expensive to find out.
    function test_everyArtContractFitsUnderEip170() public view {
        _fits("UnderwaterRenderer", address(renderer));
        _fits("UnderwaterFigures", address(figures));
        _fits("UnderwaterMarks", address(marks));
        _fits("UnderwaterScenes", address(scenes));
        _fits("UnderwaterNames", address(names));
    }

    function _fits(string memory what, address a) private view {
        assertLt(a.code.length, 24_576, string.concat(what, " is over the EIP-170 limit"));
    }
}
