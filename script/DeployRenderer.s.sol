// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterPlates} from "../src/nft/UnderwaterPlates.sol";
import {UnderwaterFigures} from "../src/nft/art/UnderwaterFigures.sol";
import {UnderwaterMarks} from "../src/nft/art/UnderwaterMarks.sol";
import {UnderwaterNames} from "../src/nft/art/UnderwaterNames.sol";
import {UnderwaterRenderer} from "../src/nft/art/UnderwaterRenderer.sol";
import {UnderwaterScenes} from "../src/nft/art/UnderwaterScenes.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Deploys the five art contracts and points a collection at them.
///
/// The four asset contracts hold the drawn markup and take no constructor
/// arguments; the renderer takes their addresses and is the only one the
/// collection knows about. All five are `view`-only and hold no state, so a bad
/// deploy costs gas and nothing else — `setRenderer` can be called again.
///
/// Dry run (no broadcast):
///   PLATES=0x… forge script script/DeployRenderer.s.sol --rpc-url ink_sepolia
///
/// Broadcast:
///   PLATES=0x… forge script script/DeployRenderer.s.sol --rpc-url ink --broadcast \
///     --verify --verifier blockscout --verifier-url https://explorer.inkonchain.com/api
///
/// `PLATES` is optional. Without it the art deploys and the addresses are
/// printed for a later `setRenderer`, which is the path to take when the
/// collection owner is a multisig that cannot run a script.
contract DeployRenderer is Script {
    function run() external returns (UnderwaterRenderer renderer) {
        address plates = vm.envOr("PLATES", address(0));

        console2.log("chain id        ", block.chainid);
        console2.log("deployer        ", msg.sender);
        console2.log("plates          ", plates == address(0) ? address(0) : plates);

        // Checked before spending anything: a typo'd PLATES would otherwise
        // deploy five contracts and then revert on the wire-up, leaving the art
        // on chain but unreferenced and the run needing to be picked apart by
        // hand to avoid paying for it twice.
        if (plates != address(0)) _assertPlatesIsSane(plates);

        vm.startBroadcast();

        UnderwaterFigures figures = new UnderwaterFigures();
        UnderwaterMarks marks = new UnderwaterMarks();
        UnderwaterScenes scenes = new UnderwaterScenes();
        UnderwaterNames names = new UnderwaterNames();
        renderer = new UnderwaterRenderer(figures, marks, scenes, names);

        // Only when the broadcaster is the owner. `setRenderer` is `onlyOwner`,
        // so attempting it otherwise would revert the whole run and throw away
        // five perfectly good deploys.
        bool wired = plates != address(0) && UnderwaterPlates(plates).owner() == msg.sender;
        if (wired) UnderwaterPlates(plates).setRenderer(address(renderer));

        vm.stopBroadcast();

        console2.log("");
        console2.log("UnderwaterFigures ", address(figures));
        console2.log("UnderwaterMarks   ", address(marks));
        console2.log("UnderwaterScenes  ", address(scenes));
        console2.log("UnderwaterNames   ", address(names));
        console2.log("UnderwaterRenderer", address(renderer));

        _reportSizes(address(renderer), address(figures), address(marks), address(scenes), address(names));

        console2.log("");
        if (wired) {
            console2.log("setRenderer done. tokenURI resolves from now on.");
            console2.log("Verify before minting opens:");
            console2.log("  cast call <plates> 'tokenURI(uint256)' 1 --rpc-url <net>");
            console2.log("");
            console2.log("freezeRenderer() gives up the ability to replace it. Do not call it");
            console2.log("until a plate has been rendered on a real marketplace.");
        } else if (plates != address(0)) {
            console2.log("NOT wired: the broadcaster does not own the collection.");
            console2.log("The owner must call:");
            console2.log("  cast send <plates> 'setRenderer(address)'", address(renderer));
        } else {
            console2.log("PLATES not set, so nothing was wired. The owner must call:");
            console2.log("  cast send <plates> 'setRenderer(address)'", address(renderer));
        }
    }

    /// @dev The collection is the one address here that is not deployed by this
    ///      script, so it is the one that can be wrong.
    function _assertPlatesIsSane(address plates) internal view {
        require(plates.code.length > 0, "PLATES is not a contract");

        // Two reads that a non-collection address will not answer: the supply is
        // a constant this repo sets, and the trophy is deployed in the plates
        // constructor and can never be zero.
        require(UnderwaterPlates(plates).SUPPLY() == 2222, "PLATES is not an Underwater collection");
        require(address(UnderwaterPlates(plates).trophy()) != address(0), "PLATES has no trophy");

        // Replacing a frozen renderer is impossible, so deploying art for one is
        // pure waste. Caught here rather than in the revert of the last call.
        require(!UnderwaterPlates(plates).rendererFrozen(), "PLATES renderer is frozen");
    }

    /// @dev EIP-170 caps runtime code at 24,576 B. The tests assert this too, but
    ///      the tests run against the compiler settings in `foundry.toml` — this
    ///      is the same check against what actually landed on the chain, which is
    ///      the only measurement that decides whether the deploy worked.
    function _reportSizes(address renderer, address figures, address marks, address scenes, address names)
        internal
        view
    {
        console2.log("");
        console2.log("runtime code, against the 24576 B EIP-170 ceiling:");
        _size("renderer", renderer);
        _size("figures ", figures);
        _size("marks   ", marks);
        _size("scenes  ", scenes);
        _size("names   ", names);
    }

    function _size(string memory what, address a) internal view {
        uint256 n = a.code.length;
        require(n > 0, "a contract deployed as empty");
        require(n <= 24_576, "a contract is over the EIP-170 limit");
        console2.log(string.concat("  ", what), n);
    }
}
