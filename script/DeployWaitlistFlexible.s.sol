// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterWaitlistFlexible} from "../src/nft/UnderwaterWaitlistFlexible.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Deploys the allowlist waitlist with an owner-adjustable window.
///
/// Unlike DeployWaitlist.s.sol, the window here is NOT final: the owner can move
/// either edge later with `setWindow`. That is the whole point of this variant,
/// and it carries the trade-off that comes with it — a settable deadline is a
/// lever over who is eligible, held by the owner, after people have acted on the
/// published one. If the window must be verifiably beyond anyone's reach, deploy
/// UnderwaterWaitlist instead.
///
/// The owner is whoever broadcasts, unless `OWNER` is set, matching the other
/// settable deploys in this repo (DeployPlates, DeployPoints).
///
/// Dry run (no broadcast):
///   forge script script/DeployWaitlistFlexible.s.sol --rpc-url robinhood
///
/// Broadcast:
///   forge script script/DeployWaitlistFlexible.s.sol --rpc-url robinhood --broadcast
///
/// Robinhood mainnet source verification sits behind a Cloudflare interstitial a
/// CLI cannot pass, so if the source must be verified, paste it into the
/// explorer's own form rather than passing --verify here.
contract DeployWaitlistFlexible is Script {
    function run() external returns (UnderwaterWaitlistFlexible waitlist) {
        // Whoever broadcasts owns it. Named explicitly rather than left implicit,
        // because the owner is the only address that can move the window and it
        // is worth reading back off the console before signing.
        address owner = vm.envOr("OWNER", msg.sender);
        // Default: opens on the next block. Set WAITLIST_OPENS to announce a start
        // time in advance, which is the difference between a fair race and one
        // where whoever is watching the deploy tx registers first.
        uint256 opensAt = vm.envOr("WAITLIST_OPENS", block.timestamp);
        uint256 window = vm.envOr("WAITLIST_WINDOW", uint256(7 days));
        // WAITLIST_CLOSES wins if set, so a hard deadline can be given as a date
        // rather than as arithmetic on a start time nobody wrote down.
        uint256 closesAt = vm.envOr("WAITLIST_CLOSES", opensAt + window);

        require(closesAt > opensAt, "WAITLIST_CLOSES is not after WAITLIST_OPENS");
        require(closesAt > block.timestamp, "WAITLIST_CLOSES is in the past");

        console2.log("chain id     ", block.chainid);
        console2.log("deployer     ", msg.sender);
        console2.log("owner        ", owner);
        console2.log("now          ", block.timestamp);
        console2.log("opens at     ", opensAt);
        console2.log("closes at    ", closesAt);
        console2.log("open for     ", (closesAt - opensAt) / 1 hours, "hours");

        if (opensAt <= block.timestamp) {
            console2.log("");
            console2.log("NOTE: opens immediately. Registration is live the moment this lands.");
        } else {
            console2.log("opens in     ", (opensAt - block.timestamp) / 1 hours, "hours");
        }

        vm.startBroadcast();
        waitlist = new UnderwaterWaitlistFlexible(owner, opensAt, closesAt);
        vm.stopBroadcast();

        console2.log("");
        console2.log("UnderwaterWaitlistFlexible deployed at", address(waitlist));
        console2.log("");
        console2.log("The owner can move either edge of the window with setWindow(opensAt, closesAt).");
        console2.log("A close must stay after its open and after `now`, and the one window that is");
        console2.log("already over is rejected. The list itself is untouched by a window change.");
        console2.log("");
        console2.log("Next:");
        console2.log("  1. NEXT_PUBLIC_WAITLIST_ROBINHOOD=<address> in web/.env.local, then rebuild");
        console2.log("     (the var is NEXT_PUBLIC_WAITLIST_<KEY> for the network's registry key)");
        console2.log("  2. publish ALLOWLIST.hash on chain if this intake feeds the plates allowlist");
        console2.log("  3. adjust the window any time with:");
        console2.log("       cast send <waitlist> 'setWindow(uint256,uint256)' <opens> <closes>");
        console2.log("");
        console2.log("Registration is all this contract does. Drawing a list from it (npm run");
        console2.log("waitlist, select.py, whitelist.py, SetWhitelist.s.sol) is a later step and");
        console2.log("needs a plates collection, which cannot be deployed on a chain without Aave V3.");
    }
}
