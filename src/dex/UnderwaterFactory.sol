// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import {Owned} from "../utils/Owned.sol";
import {UnderwaterPair} from "./UnderwaterPair.sol";

/// @title UnderwaterFactory
/// @notice Deploys and registers Underwater liquidity pools.
///
/// @dev Pairs are deployed with CREATE2 salted by the sorted token addresses,
///      so a pool's address is known before it exists and cannot be squatted.
///      The event signature matches `UniswapV2Factory.PairCreated` so existing
///      V2 indexers — including chart and aggregator backends — can ingest this
///      DEX without custom decoding.
///
///      Ownership is limited to one power: turning the protocol fee on or off
///      and choosing where it goes. There is no pause, no pair blocklist, no
///      per-pair fee override and no upgrade path, so the owner cannot touch
///      anyone's liquidity or interfere with a trade.
contract UnderwaterFactory is Owned {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 length);
    event FeeToChanged(address indexed previousFeeTo, address indexed newFeeTo);

    error IdenticalAddresses();
    error PairExists();

    /// @notice Recipient of the protocol's share of swap fees, or zero when the
    ///         fee is off. While zero, 100% of the 0.3% accrues to LPs.
    address public feeTo;

    /// @notice Pool for a token pair, in either argument order. Zero if none.
    mapping(address tokenA => mapping(address tokenB => address pair)) public getPair;

    address[] public allPairs;

    constructor(address owner_) Owned(owner_) {}

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice Deploy the pool for `tokenA`/`tokenB`. Permissionless.
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        // Only token0 needs checking: it is the smaller of the two addresses,
        // so if it is non-zero then token1 is too.
        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairExists();

        pair = address(new UnderwaterPair{salt: keccak256(abi.encodePacked(token0, token1))}());
        UnderwaterPair(pair).initialize(token0, token1);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    /// @notice Switch the protocol fee on (non-zero) or off (zero).
    function setFeeTo(address newFeeTo) external onlyOwner {
        emit FeeToChanged(feeTo, newFeeTo);
        feeTo = newFeeTo;
    }

    /// @notice keccak256 of the pair creation code, for off-chain CREATE2
    ///         address derivation.
    /// @dev Exposed on-chain deliberately. V2 forks traditionally hard-code this
    ///      hash into a router library, and a stale hash silently points the
    ///      router at addresses where no pool exists — one of the most common
    ///      ways a fork ships broken. Nothing in this repo hard-codes it:
    ///      `UnderwaterLibrary.pairFor` reads the factory's registry instead.
    function pairInitCodeHash() external pure returns (bytes32) {
        return keccak256(type(UnderwaterPair).creationCode);
    }
}
