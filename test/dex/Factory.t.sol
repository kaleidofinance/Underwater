// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterFactory} from "../../src/dex/UnderwaterFactory.sol";
import {UnderwaterPair} from "../../src/dex/UnderwaterPair.sol";
import {Owned} from "../../src/utils/Owned.sol";
import {TestERC20} from "./mocks/DexMocks.sol";
import {Test} from "forge-std/Test.sol";

contract FactoryTest is Test {
    UnderwaterFactory internal factory;
    TestERC20 internal tokenA;
    TestERC20 internal tokenB;

    address internal constant OWNER = address(0xA11CE);
    address internal constant STRANGER = address(0xB0B);
    address internal constant TREASURY = address(0xFEE);

    function setUp() public {
        factory = new UnderwaterFactory(OWNER);
        tokenA = new TestERC20("A", "A");
        tokenB = new TestERC20("B", "B");
    }

    function test_createPairRegistersBothOrderings() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        assertEq(factory.getPair(address(tokenA), address(tokenB)), pair, "forward lookup");
        assertEq(factory.getPair(address(tokenB), address(tokenA)), pair, "reverse lookup");
        assertEq(factory.allPairsLength(), 1);
        assertEq(factory.allPairs(0), pair);
    }

    function test_pairIsInitializedWithSortedTokens() public {
        address pair = factory.createPair(address(tokenB), address(tokenA));
        (address expected0, address expected1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));

        assertEq(UnderwaterPair(pair).token0(), expected0);
        assertEq(UnderwaterPair(pair).token1(), expected1);
        assertEq(UnderwaterPair(pair).factory(), address(factory));
    }

    /// @dev The guard against the classic V2-fork bug: a hard-coded init code
    ///      hash that no longer matches the deployed pair. Nothing in this repo
    ///      hard-codes it, and this proves the value the factory publishes is
    ///      the one CREATE2 actually used.
    function test_publishedInitCodeHashDerivesTheRealPairAddress() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        (address token0, address token1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));

        address predicted = vm.computeCreate2Address(
            keccak256(abi.encodePacked(token0, token1)), factory.pairInitCodeHash(), address(factory)
        );

        assertEq(pair, predicted, "off-chain derivation must match on-chain CREATE2");
    }

    function test_pairAddressIsKnownBeforeCreation() public {
        (address token0, address token1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        address predicted = vm.computeCreate2Address(
            keccak256(abi.encodePacked(token0, token1)), factory.pairInitCodeHash(), address(factory)
        );
        assertEq(predicted.code.length, 0, "nothing deployed yet");

        assertEq(factory.createPair(address(tokenA), address(tokenB)), predicted);
    }

    function test_duplicatePairReverts() public {
        factory.createPair(address(tokenA), address(tokenB));

        vm.expectRevert(UnderwaterFactory.PairExists.selector);
        factory.createPair(address(tokenA), address(tokenB));

        // Reverse order hits the same registry entry.
        vm.expectRevert(UnderwaterFactory.PairExists.selector);
        factory.createPair(address(tokenB), address(tokenA));
    }

    function test_identicalTokensRevert() public {
        vm.expectRevert(UnderwaterFactory.IdenticalAddresses.selector);
        factory.createPair(address(tokenA), address(tokenA));
    }

    function test_zeroTokenReverts() public {
        vm.expectRevert(Owned.ZeroAddress.selector);
        factory.createPair(address(0), address(tokenA));

        vm.expectRevert(Owned.ZeroAddress.selector);
        factory.createPair(address(tokenA), address(0));
    }

    function test_createPairIsPermissionless() public {
        vm.prank(STRANGER);
        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertTrue(pair != address(0));
    }

    function test_initializeIsFactoryOnlyAndOneShot() public {
        UnderwaterPair pair = UnderwaterPair(factory.createPair(address(tokenA), address(tokenB)));

        vm.expectRevert(UnderwaterPair.Forbidden.selector);
        pair.initialize(address(1), address(2));

        vm.prank(address(factory));
        vm.expectRevert(UnderwaterPair.AlreadyInitialized.selector);
        pair.initialize(address(1), address(2));
    }

    // ─── Fee switch ───────────────────────────────────────────────────────

    function test_feeIsOffByDefault() public view {
        assertEq(factory.feeTo(), address(0));
    }

    function test_onlyOwnerSetsFeeTo() public {
        vm.expectRevert(Owned.NotOwner.selector);
        factory.setFeeTo(TREASURY);

        vm.prank(OWNER);
        factory.setFeeTo(TREASURY);
        assertEq(factory.feeTo(), TREASURY);

        vm.prank(OWNER);
        factory.setFeeTo(address(0));
        assertEq(factory.feeTo(), address(0));
    }

    function test_ownershipHandoverIsTwoStep() public {
        vm.prank(OWNER);
        factory.transferOwnership(STRANGER);
        assertEq(factory.owner(), OWNER, "not transferred until accepted");

        vm.prank(STRANGER);
        factory.acceptOwnership();
        assertEq(factory.owner(), STRANGER);

        vm.prank(STRANGER);
        factory.setFeeTo(TREASURY);
        assertEq(factory.feeTo(), TREASURY);
    }

    function testFuzz_everyPairAddressIsUniqueAndDerivable(uint256 count) public {
        count = bound(count, 1, 5);
        address weth = address(new TestERC20("W", "W"));

        for (uint256 i; i < count; ++i) {
            address token = address(new TestERC20("T", "T"));
            address pair = factory.createPair(token, weth);

            (address token0, address token1) = token < weth ? (token, weth) : (weth, token);
            assertEq(
                pair,
                vm.computeCreate2Address(
                    keccak256(abi.encodePacked(token0, token1)), factory.pairInitCodeHash(), address(factory)
                )
            );
        }
        assertEq(factory.allPairsLength(), count);
    }
}
