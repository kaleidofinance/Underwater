// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterWaitlist} from "../src/nft/UnderwaterWaitlist.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Deploys the allowlist waitlist.
///
/// The window is immutable, so this script is the only chance to get it right —
/// there is no `setClosesAt` to fix it with afterwards. Dry run first and read the
/// two dates it prints.
///
/// Deploying does not create an allowlist. It opens intake; the tree is built
/// afterwards from the registered addresses by `npm run waitlist` and
/// script/whitelist.py, under criteria that should be published *before* this is
/// deployed.
///
/// Dry run (no broadcast):
///   forge script script/DeployWaitlist.s.sol --rpc-url ink_sepolia
///
/// Broadcast:
///   forge script script/DeployWaitlist.s.sol --rpc-url ink --broadcast --verify \
///     --verifier blockscout --verifier-url https://explorer.inkonchain.com/api
contract DeployWaitlist is Script {
    function run() external returns (UnderwaterWaitlist waitlist) {
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
        waitlist = new UnderwaterWaitlist(opensAt, closesAt);
        vm.stopBroadcast();

        console2.log("");
        console2.log("UnderwaterWaitlist deployed at", address(waitlist));
        console2.log("");
        console2.log("There is no owner and no setter. The window above is final. Next:");
        console2.log("  1. NEXT_PUBLIC_WAITLIST_<chain>=<address> in web/.env.local, then rebuild");
        console2.log("  2. publish the selection criteria before registration opens");
        console2.log("  3. after it closes: npm run waitlist  (writes script/whitelist.txt)");
        console2.log("  4. python script/whitelist.py         (writes web/public/whitelist.json)");
        console2.log("  5. WL_MAX_PER_WALLET=1 forge script script/SetWhitelist.s.sol --broadcast");
    }
}
