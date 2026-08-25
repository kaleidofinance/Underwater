// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {InkAave} from "../../script/InkAave.sol";
import {UnderwaterPlates} from "../../src/nft/UnderwaterPlates.sol";
import {Test} from "forge-std/Test.sol";

interface IAaveV3Pool {
    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256);

    function getReservesList() external view returns (address[] memory);

    function ADDRESSES_PROVIDER() external view returns (address);

    function POOL_REVISION() external view returns (uint256);
}

/// @notice Pins the Aave pool the collection is deployed against, on the real
///         chains, against the live markets.
///
/// The collection's `aavePool` is immutable. Every other risky address in this repo
/// can be re-pointed by a setter or re-deployed cheaply; this one cannot, and a
/// wrong value is 2222 plates reading a health factor from something that is not
/// Aave, forever. So the address is not carried in a `.env` that has to be right by
/// hand on the single deploy that cannot be undone — it is a constant in
/// [InkAave.sol](../../script/InkAave.sol), and this is the test that says the
/// constant is still true.
///
/// It also fails if the market is wound down: a whitelabel operator delisting every
/// reserve would leave the pool answering the deploy script's probe correctly while
/// being useless to a plate.
///
/// Skipped automatically when the RPC is unreachable, so `forge test` stays green
/// offline. Run explicitly with:
///   forge test --match-contract InkAavePool -vv
abstract contract InkAavePoolForkTest is Test {
    address internal constant NOBODY = address(uint160(0xdeadbeef));

    bool internal forked;

    function _rpc() internal view virtual returns (string memory);

    function _label() internal pure virtual returns (string memory);

    function _chainId() internal pure virtual returns (uint256);

    function _pool() internal pure virtual returns (address);

    function setUp() public {
        try vm.createSelectFork(_rpc()) {
            forked = true;
        } catch {
            emit log(string.concat(_label(), " RPC unreachable - skipping fork test"));
        }
    }

    /// @dev The resolver is what the deploy script actually calls, so testing the
    ///      constant without testing the lookup would leave the mapping untested.
    function test_theResolverAgreesWithTheChainWeAreOn() public view {
        if (!forked) return;
        assertEq(block.chainid, _chainId(), "fork is not the chain this case is for");
        assertEq(InkAave.poolFor(block.chainid), _pool(), "resolver disagrees with the pinned address");
    }

    function test_thePoolIsAContractHere() public view {
        if (!forked) return;
        assertGt(_pool().code.length, 0, "no code at the pinned pool address");
    }

    /// @dev The exact assertion `DeployPlates.s.sol` gates on. If this fails, that
    ///      script refuses to deploy — which is the intended outcome, but it should
    ///      be discovered here and not on a deploy day.
    function test_thePoolPassesTheDeployScriptsProbe() public view {
        if (!forked) return;
        (,,,,, uint256 hf) = IAaveV3Pool(_pool()).getUserAccountData(NOBODY);
        assertEq(hf, type(uint256).max, "an address with no debt must read as infinitely healthy");
    }

    function test_thePoolIsAConfiguredV3Instance() public view {
        if (!forked) return;
        assertGt(IAaveV3Pool(_pool()).POOL_REVISION(), 0, "no pool revision");
        assertTrue(IAaveV3Pool(_pool()).ADDRESSES_PROVIDER() != address(0), "no addresses provider");
    }

    /// @dev A market with nothing listed cannot be borrowed against, so no plate
    ///      could ever have a position to read. This is the check that notices a
    ///      wound-down market rather than an absent one.
    function test_theMarketStillHasReservesListed() public {
        if (!forked) return;
        address[] memory reserves = IAaveV3Pool(_pool()).getReservesList();
        assertGt(reserves.length, 0, "the market has no reserves listed");
        emit log_named_uint(string.concat(_label(), " reserves listed"), reserves.length);
    }

    /// @dev The whole point, end to end: a real collection deployed against the real
    ///      market, a plate minted, dived, and its health factor read back *through
    ///      the collection* rather than by calling Aave directly. A pool that passes
    ///      every check above and still breaks the one call the art depends on would
    ///      be caught only here.
    function test_aPlateCanDiveAgainstTheRealMarket() public {
        if (!forked) return;

        address treasury = makeAddr("treasury");

        // A table of zeros, with the provenance to match, so `seal` can prove it and
        // open the collection. The real 371-word table is what ships; here the only
        // thing under test is the pool, and a table that seals is the cheapest way to
        // get a plate into somebody's hands.
        uint256[] memory table = new uint256[](371);
        UnderwaterPlates plates = new UnderwaterPlates(
            address(this),
            _pool(),
            treasury,
            keccak256(abi.encode(table)),
            0.0222 ether,
            0.00333 ether,
            1, // reserve: seal mints id 1 to the treasury, so no mint phase is needed
            block.timestamp + 1 days
        );
        assertEq(address(plates.pool()), _pool(), "the collection is wired to the pinned pool");

        plates.commit(0, table);
        plates.seal();
        assertEq(plates.ownerOf(1), treasury, "the reserve plate did not land");

        // Undived, the plate is in dry dock and never touches Aave.
        assertEq(plates.healthFactorOf(1), plates.DRY_DOCK());

        vm.prank(treasury);
        plates.dive(1);

        // Now every read goes through `pool.getUserAccountData` on the live market.
        // The treasury carries no debt there, so Aave answers `type(uint256).max` —
        // the same value as dry dock, which is exactly why this assertion is paired
        // with the wiring check above rather than standing alone.
        assertEq(plates.healthFactorOf(1), type(uint256).max, "a holder with no debt reads as afloat");

        // And the art is not drownable at that reading, which is the property the
        // whole mechanic rests on.
        vm.expectRevert();
        plates.drown(1);
    }
}

contract InkMainnetAavePoolForkTest is InkAavePoolForkTest {
    function _rpc() internal view override returns (string memory) {
        return vm.envOr("INK_RPC_URL", string("https://rpc-gel.inkonchain.com"));
    }

    function _label() internal pure override returns (string memory) {
        return "Ink mainnet";
    }

    function _chainId() internal pure override returns (uint256) {
        return 57073;
    }

    function _pool() internal pure override returns (address) {
        return InkAave.POOL_INK;
    }
}

contract InkSepoliaAavePoolForkTest is InkAavePoolForkTest {
    function _rpc() internal view override returns (string memory) {
        return vm.envOr("INK_SEPOLIA_RPC_URL", string("https://rpc-gel-sepolia.inkonchain.com"));
    }

    function _label() internal pure override returns (string memory) {
        return "Ink Sepolia";
    }

    function _chainId() internal pure override returns (uint256) {
        return 763373;
    }

    function _pool() internal pure override returns (address) {
        return InkAave.POOL_INK_SEPOLIA;
    }
}
