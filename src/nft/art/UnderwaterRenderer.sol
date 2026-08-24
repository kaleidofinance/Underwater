// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base64} from "../../utils/Base64.sol";
import {LibString} from "../../utils/LibString.sol";
import {IUnderwaterRenderer} from "../interfaces/IUnderwaterRenderer.sol";
import {UnderwaterDissolve as Dis} from "./UnderwaterDissolve.sol";
import {UnderwaterFigures} from "./UnderwaterFigures.sol";
import {UnderwaterMarks} from "./UnderwaterMarks.sol";
import {UnderwaterMath as M} from "./UnderwaterMath.sol";
import {UnderwaterNames} from "./UnderwaterNames.sol";
import {UnderwaterScenes} from "./UnderwaterScenes.sol";

/// @title UnderwaterRenderer
/// @notice Draws a plate from its traits and the health factor of the position
///         behind it, and returns a complete token URI. No storage, no owner,
///         nothing to configure.
///
/// @dev This is a port of `art/render.py`, which is the renderer the art was
///      designed with and is treated here as the oracle: the two must produce the
///      same bytes, not merely the same picture. Everything that makes that
///      possible lives in `UnderwaterMath` — integer draws, one rounding
///      primitive, no floating point anywhere — and everything that could drift
///      between the two is generated from `art/traits/**` rather than
///      transcribed.
///
///      What is hand-written here is the composition and the palette, and
///      `art/render.py:check_palette` fails the build if either falls out of step
///      with the manifest. That check exists because these nine colours and four
///      option orderings are the only numbers in the system that appear in two
///      places by necessity.
///
///      On the shape of the code: it is written in small functions passing a
///      memory struct rather than as a few long ones with many locals, because
///      composing a 12KB SVG in one frame overflows the Yul stack allocator. That
///      failure has no line number attached, so the structure here is defensive.
contract UnderwaterRenderer is IUnderwaterRenderer {
    error BadIndex();
    error NoAssets();

    // ─── Wiring ───────────────────────────────────────────────────────────

    /// @dev The four generated asset contracts. Immutable and separately
    ///      deployed: EIP-170 caps runtime code at 24,576 B and the art alone is
    ///      ~17.8 KB, so they cannot live here. Anyone can read all four back with
    ///      `eth_getCode` and diff them against the committed sources.
    UnderwaterFigures public immutable figures;
    UnderwaterMarks public immutable marks;
    UnderwaterScenes public immutable scenes;
    UnderwaterNames public immutable names;

    // ─── Trait layout ─────────────────────────────────────────────────────
    //
    // Ten categories, four bits each, category 0 in the low nibble. The shifts are
    // named rather than inlined because reading the wrong nibble produces valid art
    // for the wrong plate, which is the sort of bug that ships.

    uint256 private constant NIBBLE = 15;
    uint256 private constant DIVER = 0;
    uint256 private constant HEADGEAR = 4;
    uint256 private constant HELD = 8;
    uint256 private constant RELIC = 12;
    uint256 private constant EMBLEM = 16;
    uint256 private constant SCENE = 20;
    uint256 private constant TETHER = 24;
    uint256 private constant FAUNA = 28;
    uint256 private constant PIGMENT = 32;
    uint256 private constant SUBSTRATE = 36;

    // ─── States ───────────────────────────────────────────────────────────
    //
    // The depth bands from the manifest, plus the two states a position can be in
    // that are not depths at all. Ordered so that a larger number is deeper, with
    // DRY_DOCK last because it is outside the ordering entirely.

    uint256 private constant SURFACE = 0;
    uint256 private constant TWILIGHT = 1;
    uint256 private constant MIDNIGHT = 2;
    uint256 private constant CRUSH = 3;
    uint256 private constant DROWNED = 4;
    uint256 private constant DRY_DOCK = 5;

    /// @dev A near-death dip leaves a salt ring and a crease. The collection caps
    ///      these at 8; this clamps rather than reverts, because a renderer that
    ///      can make `tokenURI` throw is worse than one that draws eight scars on a
    ///      plate that somehow earned nine.
    uint256 private constant MAX_SCARS = 8;

    // ─── Palette ──────────────────────────────────────────────────────────
    //
    // The trait-free states have no pigment to look up, so they carry their own.

    string private constant OXBLOOD = "#7A2318";
    string private constant SEPIA = "#5C3A1E";
    string private constant WASHI = "#E8E2D2";
    string private constant ABYSS = "#060A10";

    // ─── Copy ─────────────────────────────────────────────────────────────

    string private constant LIVE_NOTE = "A leveraged Aave position on Ink, drawn from life. The ink holds while the position does,"
        " and comes apart in the water as the health factor falls toward liquidation. Rendered"
        " entirely on chain, from the health factor at the moment you asked for it.";

    string private constant DROWNED_NOTE = "This position liquidated. What the plate recorded is gone and the paper with it; the"
        " underwriter's stamp is all that stayed crisp. The engraved kill went to whoever closed"
        " the position.";

    string private constant SEALED_NOTE = "A sealed survey tube. Which plate is inside is decided when the collection reveals - not"
        " before it, and not by anyone. Every tube looks like this one, because at this point every"
        " tube is this one.";

    constructor(
        UnderwaterFigures figures_,
        UnderwaterMarks marks_,
        UnderwaterScenes scenes_,
        UnderwaterNames names_
    ) {
        if (
            address(figures_) == address(0) || address(marks_) == address(0) || address(scenes_) == address(0)
                || address(names_) == address(0)
        ) revert NoAssets();

        figures = figures_;
        marks = marks_;
        scenes = scenes_;
        names = names_;
    }

    // ─── Entry point ──────────────────────────────────────────────────────

    /// @inheritdoc IUnderwaterRenderer
    function render(uint256 id, uint256 traits, uint256 healthFactor, uint256 scars, bool revealed)
        external
        view
        returns (string memory)
    {
        // Before the reveal there is nothing to look up, so this comes first and
        // ignores everything else it was handed — the collection passes zero for
        // the traits, and a zero here would otherwise render as plate-index-zero's
        // art for every token.
        if (!revealed) {
            return _uri(id, _sealed(id), '{"trait_type":"State","value":"Sealed"}', SEALED_NOTE);
        }

        Plate memory p = _plate(id, traits);

        if (healthFactor <= Dis.WAD) {
            // The stamp outlives the plate, so it is the one asset a drowned token
            // still fetches.
            (,, string memory stamp) = marks.parts(_at(traits, RELIC), _at(traits, EMBLEM));
            return _uri(id, _drowned(p, stamp), _attributes(traits, DROWNED, scars), DROWNED_NOTE);
        }

        uint256 band = _band(healthFactor);
        return _uri(id, _live(p, healthFactor, band, scars), _attributes(traits, band, scars), LIVE_NOTE);
    }

    // ─── The plate ────────────────────────────────────────────────────────

    /// @dev One plate's unpacked description, threaded through the composition by
    ///      reference. A struct rather than six locals in every helper: the SVG is
    ///      assembled in a dozen steps and most of these are live for all of them.
    struct Plate {
        uint256 id;
        uint256 traits;
        uint256 seed;
        string uid;
        string ink;
        string paper;
    }

    function _plate(uint256 id, uint256 traits) private pure returns (Plate memory p) {
        uint256 substrate = _at(traits, SUBSTRATE);

        p.id = id;
        p.traits = traits;
        p.seed = M.seedFor(id);
        // Scoped to the token so two plates on one page cannot capture each
        // other's filters — marketplaces do put them on one page.
        p.uid = string.concat("p", LibString.toString(id));
        p.ink = _ink(_at(traits, PIGMENT), substrate);
        p.paper = _paper(substrate);
    }

    /// @dev A plate with a position still open behind it.
    ///
    ///      Split into head / layers / tail rather than composed here, and each
    ///      part built in its own frame: a dozen live string locals in one function
    ///      overflows the Yul stack allocator, which reports `Stack too deep` with
    ///      only a column to point at. Three calls that each hold four is the shape
    ///      that compiles, and the seams fall where the picture has them anyway.
    function _live(Plate memory p, uint256 healthFactor, uint256 band, uint256 scars)
        private
        view
        returns (string memory)
    {
        Dis.Params memory q = Dis.paramsFor(healthFactor);
        (string memory inner, string memory stamp) = _inner(p);

        string memory head = _head(p, q, band, scars);
        string memory layers = _layers(p, q, inner, band == DRY_DOCK);
        return string.concat(head, layers, _tail(p, band, stamp));
    }

    /// @dev The shell, the filter definitions, and everything printed on the paper
    ///      before any ink is laid down.
    function _head(Plate memory p, Dis.Params memory q, uint256 band, uint256 scars)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            _open(p.id, _lower(band)),
            _defs(p, q),
            _substrate(p),
            // Scars come off their own stream, so a plate's salt rings do not move
            // when a relic is added to it.
            _scars(p.seed + 7, scars)
        );
    }

    /// @dev The figure, drawn twice: once through the coarse bleed filter and once
    ///      through the sharp one. That is what makes the ink look like it is
    ///      spreading into wet paper rather than simply blurring.
    function _layers(Plate memory p, Dis.Params memory q, string memory inner, bool dry)
        private
        pure
        returns (string memory)
    {
        string memory bleed = string.concat(
            '<g filter="url(#ble',
            p.uid,
            ')" opacity="',
            // Dry dock has no bleed at all: nothing has been in the water.
            dry ? "0" : M.decimal(q.bleedOp, 2),
            '">',
            inner,
            "</g>"
        );
        return string.concat(
            bleed, '<g filter="url(#dis', p.uid, ')" opacity="', M.decimal(q.op, 2), '">', inner, "</g>"
        );
    }

    /// @dev The stamp — outside both filters, because it is the one mark on the
    ///      plate that never dissolves — then the grain and the footer.
    function _tail(Plate memory p, uint256 band, string memory stamp) private pure returns (string memory) {
        return string.concat(stamp, _grain(p.uid), _footer(p.id, p.ink, _upper(band)), "</svg>");
    }

    /// @dev Everything that dissolves, in paint order, plus the stamp — which does
    ///      not, and is returned separately so the caller can lay it over the top.
    ///
    ///      The PRNG order is the prototype's and is load-bearing: the relic's
    ///      encrustation is drawn before the fauna, off the same stream, and a
    ///      blank relic consumes nothing at all. Swapping those, or advancing the
    ///      stream for a relic that is not there, reshuffles every mote on the
    ///      plate.
    function _inner(Plate memory p) private view returns (string memory inner, string memory stamp) {
        uint256 t = p.traits;
        uint256 rng = p.seed;

        (string memory backdrop, string memory umbilical) =
            scenes.parts(_at(t, SCENE), _at(t, TETHER), _at(t, DIVER));
        inner = backdrop;

        {
            (string memory card, string memory cardClose, string memory mark) =
                marks.parts(_at(t, RELIC), _at(t, EMBLEM));
            stamp = mark;

            if (bytes(card).length != 0) {
                string memory barnacles;
                (barnacles, rng) = _encrustation(rng);
                inner = string.concat(inner, card, barnacles, cardClose);
            }
        }

        inner = string.concat(inner, umbilical);

        {
            (string memory body, string memory worn, string memory carried) =
                figures.parts(_at(t, DIVER), _at(t, HEADGEAR), _at(t, HELD));
            inner = string.concat(inner, body, worn, carried);
        }

        inner = string.concat(inner, _fauna(_at(t, FAUNA), rng));
    }

    // ─── Filters ──────────────────────────────────────────────────────────

    function _defs(Plate memory p, Dis.Params memory q) private pure returns (string memory) {
        return string.concat(
            "<defs>",
            _paperDefs(p.uid),
            _dissolveFilter(p.uid, q, p.seed),
            _bleedFilter(p.uid, q, p.seed),
            _style(p.uid, p.ink, p.paper),
            "</defs>"
        );
    }

    /// @dev The vellum wash and the paper grain. Both are fixed — nothing about
    ///      them moves with the health factor.
    function _paperDefs(string memory uid) private pure returns (string memory) {
        return string.concat(
            '<linearGradient id="vg',
            uid,
            '" x1="0" y1="0" x2="1" y2="1">'
            '<stop offset="0" stop-color="#F4EDD8"/><stop offset="1" stop-color="#E2D8BE"/>'
            "</linearGradient>" '<filter id="grain',
            uid,
            '" x="0" y="0" width="100%" height="100%">'
            '<feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" result="n"/>'
            '<feColorMatrix in="n" type="saturate" values="0"/></filter>'
        );
    }

    /// @dev The sharp layer: turbulence, displacement, blur, desaturation. The
    ///      filter region is oversized because displaced ink leaves the shape it
    ///      came from, and a tight region would clip the plumes flat.
    function _dissolveFilter(string memory uid, Dis.Params memory q, uint256 seed)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '<filter id="dis',
            uid,
            '" x="-35%" y="-30%" width="170%" height="165%" color-interpolation-filters="sRGB">'
            '<feTurbulence type="fractalNoise" baseFrequency="',
            M.decimal(q.freq, 4),
            '" numOctaves="4" seed="',
            LibString.toString(seed),
            '" result="n"/>' '<feDisplacementMap in="SourceGraphic" in2="n" scale="',
            M.decimal(q.disp, 1),
            '" xChannelSelector="R" yChannelSelector="G" result="w"/>' '<feGaussianBlur in="w" stdDeviation="',
            M.decimal(q.blur, 2),
            '" result="s"/><feColorMatrix in="s" type="saturate" values="',
            M.decimal(q.sat, 2),
            '"/></filter>'
        );
    }

    /// @dev The bleed layer underneath: same idea, coarser and wider, on a
    ///      different turbulence seed so the two do not move together. Its opacity
    ///      is what rises as the position deteriorates.
    function _bleedFilter(string memory uid, Dis.Params memory q, uint256 seed)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '<filter id="ble',
            uid,
            '" x="-55%" y="-45%" width="210%" height="195%" color-interpolation-filters="sRGB">'
            '<feTurbulence type="fractalNoise" baseFrequency="',
            M.decimal(q.bleedFreq, 4),
            '" numOctaves="3" seed="',
            LibString.toString(seed + 11),
            '" result="n"/>' '<feDisplacementMap in="SourceGraphic" in2="n" scale="',
            M.decimal(q.bleedDisp, 1),
            '" xChannelSelector="R" yChannelSelector="G" result="w"/>' '<feGaussianBlur in="w" stdDeviation="',
            M.decimal(q.bleedBlur, 2),
            '"/></filter>'
        );
    }

    /// @dev Four classes, so every asset can be drawn in the abstract and pick up
    ///      the plate's pigment here. Scoped by id for the same reason the filters
    ///      are.
    function _style(string memory uid, string memory ink, string memory paper)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            "<style>#",
            uid,
            " .fill{fill:",
            ink,
            "}#",
            uid,
            " .st{fill:none;stroke:",
            ink,
            ";stroke-linecap:round;stroke-linejoin:round}#",
            uid,
            " .paperfill{fill:",
            paper,
            "}#",
            uid,
            " .paperst{fill:none;stroke:",
            paper,
            ";stroke-linecap:round}</style>"
        );
    }

    // ─── Paper ────────────────────────────────────────────────────────────

    /// @dev The substrate, and whatever is printed on it. Ledger ruling and the
    ///      blueprint grid are loops rather than stored markup: 47 paths of
    ///      near-identical text would be ~4 KB of code to avoid arithmetic that
    ///      costs nothing in a view call.
    function _substrate(Plate memory p) private pure returns (string memory out) {
        uint256 sub = _at(p.traits, SUBSTRATE);
        out = string.concat('<rect width="400" height="620" fill="', p.paper, '"/>');

        if (sub == 1) {
            out = string.concat(out, '<rect width="400" height="620" fill="url(#vg', p.uid, ')"/>');
        } else if (sub == 2) {
            for (uint256 y = 52; y < 620; y += 26) {
                out = string.concat(out, _rule("M0 ", y, " H400", "#9C8A63", ".9", ".34"));
            }
            // The red margin, the one line on ledger paper that is not a rule.
            out = string.concat(
                out, '<path d="M54 0 V620" stroke="#A5543F" stroke-width="1.2" opacity=".42"/>'
            );
        } else if (sub == 3) {
            for (uint256 x = 0; x <= 400; x += 25) {
                out = string.concat(out, _rule("M", x, " 0 V620", "#5B8FB0", ".7", ".26"));
            }
            for (uint256 y = 0; y <= 620; y += 25) {
                out = string.concat(out, _rule("M0 ", y, " H400", "#5B8FB0", ".7", ".26"));
            }
        }
        // Washi is index 0 and takes nothing; `_paper` has already rejected
        // anything above 3.
    }

    function _rule(
        string memory lead,
        uint256 at,
        string memory rest,
        string memory stroke,
        string memory width,
        string memory opacity
    ) private pure returns (string memory) {
        return string.concat(
            '<path d="',
            lead,
            LibString.toString(at),
            rest,
            '" stroke="',
            stroke,
            '" stroke-width="',
            width,
            '" opacity="',
            opacity,
            '"/>'
        );
    }

    /// @dev Salt rings and creases, on the paper and never on the figure: a scar
    ///      records that the holder held on, not that the diver was hurt.
    function _scars(uint256 seed, uint256 count) private pure returns (string memory out) {
        uint256 rng = seed;
        uint256 n = count > MAX_SCARS ? MAX_SCARS : count;

        for (uint256 i; i < n; ++i) {
            uint256 d;
            (rng, d) = M.next(rng);
            string memory cx = M.draw(d, 340, 30, 0);
            (rng, d) = M.next(rng);
            string memory cy = M.draw(d, 540, 40, 0);

            // Held as numerators, not as rounded radii: the inner ring is 0.62 of
            // the outer and the prototype took that fraction before rounding.
            (rng, d) = M.next(rng);
            uint256 rx = M.numerator(d, 66, 42);
            (rng, d) = M.next(rng);
            uint256 ry = M.numerator(d, 44, 30);
            out = string.concat(out, _ring(cx, cy, rx, ry));

            (rng, d) = M.next(rng);
            uint256 y = M.drawInt(d, 520, 50);
            (rng, d) = M.next(rng);
            out = string.concat(out, _crease(y, M.draw(d, 160, 60, 0)));
        }
    }

    function _ring(string memory cx, string memory cy, uint256 rx, uint256 ry)
        private
        pure
        returns (string memory)
    {
        string memory outer = string.concat(
            '<ellipse cx="',
            cx,
            '" cy="',
            cy,
            '" rx="',
            LibString.toString(M.nearest(rx, M.TWO32)),
            '" ry="',
            LibString.toString(M.nearest(ry, M.TWO32)),
            '" fill="none" stroke="#7A5A2A" stroke-width="2.4" opacity=".2"/>'
        );
        return string.concat(
            outer,
            '<ellipse cx="',
            cx,
            '" cy="',
            cy,
            '" rx="',
            LibString.toString(M.nearest(rx * 62, M.TWO32 * 100)),
            '" ry="',
            LibString.toString(M.nearest(ry * 62, M.TWO32 * 100)),
            '" fill="#8A6A34" opacity=".07"/>'
        );
    }

    /// @dev The two derived heights come off the rounded `y` rather than off its
    ///      numerator, and that is exact rather than convenient: shifting a
    ///      non-negative value by a whole number commutes with rounding it.
    function _crease(uint256 y, string memory qx) private pure returns (string memory) {
        string memory top = LibString.toString(y);
        return string.concat(
            '<path d="M0 ',
            top,
            " Q",
            qx,
            " ",
            LibString.toString(y - 16),
            " 200 ",
            top,
            " T400 ",
            LibString.toString(y - 8),
            '" fill="none" stroke="#6B5433" stroke-width="1.1" opacity=".24"/>'
        );
    }

    // ─── Procedural life ──────────────────────────────────────────────────

    function _fauna(uint256 kind, uint256 rng) private pure returns (string memory) {
        if (kind == 0) return _shoal(rng);
        if (kind == 1) {
            // The one fauna option with no randomness in it. A lone predator that
            // moved around would be a different animal every render.
            return '<g opacity=".5"><path d="M300 470 q34 -19 68 0 q-30 12 -68 0 z" class="fill"/>'
                '<path d="M368 470 l20 -13 v26 z" class="fill"/>'
                '<circle cx="318" cy="468" r="2.6" class="paperfill"/></g>';
        }
        if (kind == 2) return _motes(rng);
        if (kind == 3) return "";
        revert BadIndex();
    }

    /// @dev Nine fish. Drawn x, y, scale, opacity — in that order, whatever order
    ///      they are printed in, because the stream is shared with everything
    ///      after it.
    function _shoal(uint256 rng) private pure returns (string memory out) {
        for (uint256 i; i < 9; ++i) {
            uint256 d;
            (rng, d) = M.next(rng);
            string memory x = M.draw(d, 300, 40, 0);
            (rng, d) = M.next(rng);
            string memory y = M.draw(d, 180, 400, 0);
            (rng, d) = M.next(rng);
            string memory k = M.draw(d, 50, 50, 2);
            (rng, d) = M.next(rng);

            out = string.concat(
                out,
                '<g opacity="',
                M.draw(d, 34, 24, 2),
                '" transform="translate(',
                x,
                " ",
                y,
                ") scale(",
                k,
                ')"><path d="M0 0 q15 -8 30 0 q-13 6 -30 0 z" class="fill"/>'
                '<path d="M30 0 l9 -6 v12 z" class="fill"/></g>'
            );
        }
    }

    /// @dev Suspended particulate. Twenty-six of them, which is enough to read as
    ///      water and few enough to stay out of the way of the figure.
    function _motes(uint256 rng) private pure returns (string memory out) {
        for (uint256 i; i < 26; ++i) {
            uint256 d;
            (rng, d) = M.next(rng);
            string memory cx = M.draw(d, 400, 0, 0);
            (rng, d) = M.next(rng);
            string memory cy = M.draw(d, 620, 0, 0);
            (rng, d) = M.next(rng);
            string memory r = M.draw(d, 34, 10, 1);
            (rng, d) = M.next(rng);

            out = string.concat(
                out,
                '<circle cx="',
                cx,
                '" cy="',
                cy,
                '" r="',
                r,
                '" class="fill" opacity="',
                M.draw(d, 40, 16, 2),
                '"/>'
            );
        }
    }

    /// @dev Four barnacles on the specimen card, drawn off the plate's own stream
    ///      so no two cards weather the same way. The only place in the art where a
    ///      draw is offset below zero, which is why `drawSigned` exists.
    function _encrustation(uint256 state) private pure returns (string memory out, uint256 rng) {
        rng = state;
        for (uint256 i; i < 4; ++i) {
            uint256 d;
            (rng, d) = M.next(rng);
            string memory cx = M.drawSigned(d, 170, 85, 2);
            (rng, d) = M.next(rng);
            string memory cy = M.drawSigned(d, 150, 55, 2);
            (rng, d) = M.next(rng);
            string memory r = M.draw(d, 10, 6, 2);
            (rng, d) = M.next(rng);

            out = string.concat(
                out,
                '<circle cx="',
                cx,
                '" cy="',
                cy,
                '" r="',
                r,
                '" class="fill" opacity="',
                M.draw(d, 30, 30, 2),
                '"/>'
            );
        }
    }

    // ─── The trait-free states ────────────────────────────────────────────

    /// @dev After liquidation. The underwriter's stamp stays crisp while
    ///      everything it insured is gone, which is the plate's whole argument and
    ///      the reason the stamp was never inside the dissolve filter.
    function _drowned(Plate memory p, string memory stamp) private pure returns (string memory) {
        string memory head = string.concat(
            _open(p.id, "drowned"),
            '<defs><radialGradient id="dg',
            p.uid,
            '" cx="50%" cy="42%" r="72%">'
            '<stop offset="0" stop-color="#0A131C"/><stop offset="1" stop-color="#03060A"/>'
            "</radialGradient>",
            _style(p.uid, OXBLOOD, ABYSS),
            "</defs>"
        );
        return string.concat(
            head,
            '<rect width="400" height="620" fill="url(#dg',
            p.uid,
            ')"/>' '<path d="M0 300 Q100 288 200 300 T400 296" stroke="#16303F" stroke-width="1.4"'
            ' fill="none" opacity=".7"/>'
            '<path d="M0 334 Q120 320 200 334 T400 328" stroke="#16303F" stroke-width="1"'
            ' fill="none" opacity=".5"/>',
            stamp,
            '<text x="200" y="586" text-anchor="middle" fill="',
            OXBLOOD,
            '" font-family="\'JetBrains Mono\',monospace" font-size="13" letter-spacing="3">'
            "DROWNED</text></svg>"
        );
    }

    /// @dev Before the reveal. Deliberately identical for every token: there is
    ///      nothing to reveal until the trait offset is drawn, and a teaser that
    ///      hinted otherwise would misrepresent when the randomness happened.
    ///
    ///      The number is real, though, and it is the same footer every other state
    ///      carries. What is sealed is which plate this is, not that it is one.
    function _sealed(uint256 id) private pure returns (string memory) {
        string memory uid = string.concat("p", LibString.toString(id));

        string memory head = string.concat(
            _open(id, "sealed survey tube"),
            '<defs><filter id="grain',
            uid,
            '" x="0" y="0" width="100%" height="100%">'
            '<feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" result="n"/>'
            '<feColorMatrix in="n" type="saturate" values="0"/></filter>' "<style>#",
            uid,
            " .fill{fill:",
            SEPIA,
            "}#",
            uid,
            " .st{fill:none;stroke:",
            SEPIA,
            ";stroke-linecap:round;stroke-linejoin:round}#",
            uid,
            " .paperfill{fill:",
            WASHI,
            "}</style></defs>"
        );

        return string.concat(
            head,
            '<rect width="400" height="620" fill="',
            WASHI,
            '"/>'
            // The hanging ring, then the tube: cap, body, base.
            '<circle cx="200" cy="94" r="11" class="st" stroke-width="2.6"/>'
            '<path d="M200 105 V126" class="st" stroke-width="2.6"/>'
            '<rect x="146" y="126" width="108" height="34" rx="8" class="st" stroke-width="2.6"/>'
            '<rect x="152" y="158" width="96" height="318" rx="12" class="st" stroke-width="2.6"/>'
            '<rect x="146" y="470" width="108" height="30" rx="8" class="st" stroke-width="2.6"/>'
            // The rolled chart showing through, and the seams of the roll.
            '<path d="M176 180 V456 M200 174 V462 M224 180 V456" class="st" stroke-width="1"'
            ' opacity=".38"/>'
            // Wax, with an ink drop struck into it in place of the emblem nobody
            // has been assigned yet.
            '<circle cx="200" cy="318" r="27" class="fill" opacity=".88"/>'
            '<circle cx="200" cy="318" r="27" fill="none" stroke="',
            WASHI,
            '" stroke-width="1.4"/>' '<path d="M200 306 q10 13 0 22 q-10 -9 0 -22 z" class="paperfill"/>',
            _grain(uid),
            _footer(id, SEPIA, "SEALED"),
            "</svg>"
        );
    }

    // ─── Shell ────────────────────────────────────────────────────────────

    function _open(uint256 id, string memory label) private pure returns (string memory) {
        return string.concat(
            '<svg viewBox="0 0 400 620" id="p',
            LibString.toString(id),
            '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Plate ',
            LibString.toString(id),
            ", ",
            label,
            '">'
        );
    }

    /// @dev Multiplied over the finished plate, so ink and paper both sit in the
    ///      same tooth. Last thing drawn before the footer.
    function _grain(string memory uid) private pure returns (string memory) {
        return string.concat(
            '<rect width="400" height="620" filter="url(#grain',
            uid,
            ')" opacity=".055" style="mix-blend-mode:multiply"/>'
        );
    }

    /// @dev The plate number and the state it was last read at. Factored out
    ///      because it is the one part of the picture that is the same whether the
    ///      ink is crisp, dissolving, drowned or still in the tube.
    function _footer(uint256 id, string memory ink, string memory right)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '<g font-family="\'JetBrains Mono\',monospace" fill="',
            ink,
            '" opacity=".5"><text x="20" y="600" font-size="11" letter-spacing="1.6">No. ',
            LibString.toStringPadded(id, 4),
            ' / 2222</text><text x="380" y="600" font-size="11" letter-spacing="1.6"' ' text-anchor="end">',
            right,
            "</text></g>"
        );
    }

    // ─── Metadata ─────────────────────────────────────────────────────────

    /// @dev The ten static traits, then the two that move.
    ///
    ///      Deliberately no health factor and no depth. The health factor changes
    ///      every block and marketplaces cache metadata, so a trait carrying it
    ///      would be wrong more often than right — it is on chain as
    ///      `healthFactorOf(id)` for anyone who wants the live number. Depth is
    ///      dropped because it is a restatement of the state band, and the two
    ///      states that are not depths would need one invented for them.
    function _attributes(uint256 traits, uint256 band, uint256 scars) private view returns (string memory) {
        return string.concat(
            names.attributes(traits),
            '{"trait_type":"State","value":"',
            _name(band),
            '"},{"display_type":"number","trait_type":"Scars","value":',
            LibString.toString(scars > MAX_SCARS ? MAX_SCARS : scars),
            "}"
        );
    }

    function _uri(uint256 id, string memory image, string memory attributes, string memory note)
        private
        pure
        returns (string memory)
    {
        // Base64 for the image rather than a raw SVG data URI: the palette is full
        // of `#`, which a raw data URI has to percent-encode and which several
        // marketplaces get wrong when it is not encoded.
        string memory json = string.concat(
            '{"name":"Underwater #',
            LibString.toString(id),
            '","description":"',
            note,
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(image)),
            '","attributes":[',
            attributes,
            "]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ─── Lookups ──────────────────────────────────────────────────────────

    function _at(uint256 traits, uint256 shift) private pure returns (uint256) {
        return (traits >> shift) & NIBBLE;
    }

    /// @dev Which depth band a health factor reads as. The thresholds are the
    ///      manifest's and they are *below* the dissolve ceiling of 2.6, so a plate
    ///      is already softening before it stops saying "Surface".
    function _band(uint256 healthFactor) private pure returns (uint256) {
        if (healthFactor == type(uint256).max) return DRY_DOCK;
        if (healthFactor >= 2.5e18) return SURFACE;
        if (healthFactor >= 1.8e18) return TWILIGHT;
        if (healthFactor >= 1.4e18) return MIDNIGHT;
        return CRUSH;
    }

    /// @dev Three cases of the same five words. Stored three times rather than
    ///      case-converted at runtime, because a byte-level `toUpper` is more code
    ///      than the strings it would save and this way the bytes are readable
    ///      here.
    function _name(uint256 band) private pure returns (string memory) {
        if (band == SURFACE) return "Surface";
        if (band == TWILIGHT) return "Twilight";
        if (band == MIDNIGHT) return "Midnight";
        if (band == CRUSH) return "Crush Depth";
        if (band == DROWNED) return "Drowned";
        return "Dry Dock";
    }

    function _upper(uint256 band) private pure returns (string memory) {
        if (band == SURFACE) return "SURFACE";
        if (band == TWILIGHT) return "TWILIGHT";
        if (band == MIDNIGHT) return "MIDNIGHT";
        if (band == CRUSH) return "CRUSH DEPTH";
        return "DRY DOCK";
    }

    function _lower(uint256 band) private pure returns (string memory) {
        if (band == SURFACE) return "surface";
        if (band == TWILIGHT) return "twilight";
        if (band == MIDNIGHT) return "midnight";
        if (band == CRUSH) return "crush depth";
        return "dry dock";
    }

    /// @dev Blueprint paper is dark, so the ink inverts on it — except gold leaf,
    ///      which is the one pigment that reads on both.
    function _ink(uint256 pigment, uint256 substrate) private pure returns (string memory) {
        if (substrate == 3 && pigment != 4) return "#DCE9EF";
        if (pigment == 0) return "#12100E"; // sumi
        if (pigment == 1) return SEPIA;
        if (pigment == 2) return "#1E2F5C"; // indigo
        if (pigment == 3) return OXBLOOD;
        if (pigment == 4) return "#B08A34"; // goldleaf
        revert BadIndex();
    }

    function _paper(uint256 substrate) private pure returns (string memory) {
        if (substrate == 0) return WASHI;
        if (substrate == 1) return "#EFE7D0"; // vellum
        if (substrate == 2) return "#E6DFCB"; // ledger
        if (substrate == 3) return "#153044"; // blueprint
        revert BadIndex();
    }
}
