// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterPlates} from "../src/nft/UnderwaterPlates.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

interface IPoolProbe {
    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256);
}

/// @notice Deploys the plates collection and its trophy contract.
///
/// Deploying does not open minting. The trait table still has to be written and
/// verified against `PLATES_PROVENANCE` by script/SealPlates.s.sol, which is the
/// step that proves the art on chain is the art that was committed to.
///
/// Dry run (no broadcast):
///   forge script script/DeployPlates.s.sol --rpc-url ink_sepolia
///
/// Broadcast:
///   forge script script/DeployPlates.s.sol --rpc-url ink --broadcast --verify \
///     --verifier blockscout --verifier-url https://explorer.inkonchain.com/api
contract DeployPlates is Script {
    function run() external returns (UnderwaterPlates plates) {
        address deployer = msg.sender;
        address owner = vm.envOr("OWNER", deployer);
        address treasury = vm.envOr("PLATES_TREASURY", deployer);
        // envOr, not envAddress: an unset AAVE_POOL should hit the "not set"
        // guard below rather than a hex parse error.
        address aavePool = vm.envOr("AAVE_POOL", address(0));
        bytes32 provenance = vm.envOr("PLATES_PROVENANCE", bytes32(0));
        uint256 price = vm.envOr("PLATES_PRICE", uint256(0.0222 ether));
        // The allowlist price targets a dollar figure, so it is set at deploy and
        // re-pegged with `setWhitelistPrice` as ETH moves. Default is $10 at
        // $3,000/ETH; check the rate before a real deploy rather than trusting it.
        uint256 wlPrice = vm.envOr("PLATES_WL_PRICE", uint256(0.00333 ether));
        uint256 reserve = vm.envOr("PLATES_RESERVE", uint256(222));
        uint256 window = vm.envOr("PLATES_MINT_WINDOW", uint256(14 days));

        // The provenance hash is immutable and unrecoverable. Deploying with a
        // zero or wrong value means a collection that can never be sealed, so
        // this is the one parameter with no default.
        require(provenance != bytes32(0), "PLATES_PROVENANCE not set");

        // A wrong pool address is permanent: every plate's art would read a
        // health factor from a contract that is not Aave, and the pool is
        // immutable by design. Prove it answers like a pool before spending gas.
        _assertPoolIsSane(aavePool);

        uint256 mintCloses = block.timestamp + window;

        console2.log("chain id        ", block.chainid);
        console2.log("deployer        ", deployer);
        console2.log("owner           ", owner);
        console2.log("treasury        ", treasury);
        console2.log("aave pool       ", aavePool);
        console2.log("price (wei)     ", price);
        console2.log("wl price (wei)  ", wlPrice);
        console2.log("reserve         ", reserve);
        console2.log("mint closes at  ", mintCloses);
        console2.log("provenance      ", vm.toString(provenance));

        vm.startBroadcast();
        plates =
            new UnderwaterPlates(owner, aavePool, treasury, provenance, price, wlPrice, reserve, mintCloses);
        vm.stopBroadcast();

        console2.log("");
        console2.log("UnderwaterPlates deployed at", address(plates));
        console2.log("UnderwaterTrophy deployed at", address(plates.trophy()));
        console2.log("supply                      ", plates.SUPPLY());
        console2.log("table words to commit       ", plates.TABLE_WORDS());
        console2.log("");
        console2.log("Minting is CLOSED until the table is sealed. Next:");
        console2.log("  1. PLATES=<address> and PLATES_TABLE=<371 comma-separated words>");
        console2.log("  2. forge script script/SealPlates.s.sol --rpc-url <net> --broadcast");
        console2.log("  3. owner calls setRenderer(<renderer>) before any tokenURI resolves");
        console2.log("  4. owner calls setMerkleRoot(<root>) to open the allowlist phase");
        console2.log("  5. owner calls openPublicMint() when the allowlist is done");
        console2.log("");
        console2.log("wl allocation   ", plates.WL_ALLOCATION());
        console2.log("public phase is CLOSED until openPublicMint()");
    }

    /// @dev Aave V3 reports `type(uint256).max` as the health factor of an
    ///      address carrying no debt. Any address that answers that way for a
    ///      throwaway account is behaving like a pool; one that reverts or
    ///      returns something else is not, and is caught here rather than after
    ///      2222 plates are minted against it.
    function _assertPoolIsSane(address pool) internal view {
        require(pool != address(0), "AAVE_POOL not set");
        require(pool.code.length > 0, "AAVE_POOL is not a contract");

        (,,,,, uint256 hf) = IPoolProbe(pool).getUserAccountData(address(uint160(1)));
        require(hf == type(uint256).max, "AAVE_POOL does not answer like an Aave V3 pool");
    }
}
