// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterLaunchpad} from "../../src/UnderwaterLaunchpad.sol";
import {UnderwaterFactory} from "../../src/dex/UnderwaterFactory.sol";
import {UnderwaterPair} from "../../src/dex/UnderwaterPair.sol";
import {UnderwaterRouter} from "../../src/dex/UnderwaterRouter.sol";
import {UnderwaterLibrary} from "../../src/dex/libraries/UnderwaterLibrary.sol";
import {MemeToken} from "../../src/token/MemeToken.sol";
import {WETH9} from "../dex/mocks/DexMocks.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Solidity half of the Underwater ZEC parity harness.
///
/// The off-chain engine in `zec/engine/` claims to be an exact port of the
/// launchpad and the DEX. `zec/parity/run.ts` writes random scenarios to
/// `zec/parity/fixtures/`; this test replays each one against the real
/// contracts (launchpad wired to the real factory, router and pair, as in
/// `LaunchpadOnUnderwaterDex.t.sol`) and records the full state after every
/// operation. The runner then replays the same scenarios through the engine
/// and requires every recorded number to match.
///
/// Skipped unless ZEC_PARITY=true, so a plain `forge test` never depends on
/// generated fixtures. Run it through `node zec/parity/run.ts`.
///
/// @dev The operation encoding, error codes and state layout are a contract
///      with `zec/parity/ops.ts` and `zec/engine/errors.ts`; change them
///      together.
contract ZecParityTest is Test {
    string internal constant DIR = "zec/parity/fixtures/";
    uint256 internal constant USER_FUNDS = 1_000_000 ether;

    // Operation kinds: `Op` in zec/parity/ops.ts.
    uint256 internal constant CREATE = 0;
    uint256 internal constant BUY = 1;
    uint256 internal constant SELL = 2;
    uint256 internal constant AMM_BUY = 3;
    uint256 internal constant AMM_SELL = 4;
    uint256 internal constant GRADUATE = 5;
    uint256 internal constant SET_TRADE_FEE = 6;
    uint256 internal constant SET_GRAD_FEE = 7;
    uint256 internal constant SET_CREATION_FEE = 8;

    /// @dev `UnderwaterLaunchpad.Pool`, decoded from the `pools` getter in one
    ///      memory slot rather than eight stack slots.
    struct PoolView {
        uint128 ethReserve;
        uint128 tokenReserve;
        uint128 realEthRaised;
        uint128 tokensSold;
        address creator;
        uint40 createdAt;
        bool graduated;
        bool exists;
    }

    UnderwaterLaunchpad internal pad;
    UnderwaterFactory internal factory;
    UnderwaterRouter internal router;
    WETH9 internal weth;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address[] internal users;
    address[] internal tokens;

    function test_parity() public {
        if (!vm.envOr("ZEC_PARITY", false)) {
            vm.skip(true);
            return;
        }
        uint256 count = vm.envUint("ZEC_PARITY_COUNT");
        // Each scenario runs in its own call frame so its memory is released
        // before the next; one frame for all of them grows memory, and its
        // quadratic gas cost, without bound.
        for (uint256 s; s < count; ++s) {
            this.runScenario(s);
        }
    }

    /// @dev External only so `test_parity` can give each scenario a fresh frame.
    function runScenario(uint256 s) external {
        string memory json = vm.readFile(string.concat(DIR, "scenario-", vm.toString(s), ".json"));
        string memory out = string.concat(DIR, "trace-", vm.toString(s), ".jsonl");
        if (vm.exists(out)) vm.removeFile(out);

        factory = new UnderwaterFactory(owner);
        weth = new WETH9();
        router = new UnderwaterRouter(address(factory), address(weth));
        pad = new UnderwaterLaunchpad(
            owner,
            address(router),
            treasury,
            vm.parseJsonUint(json, ".tradeFeeBps"),
            vm.parseJsonUint(json, ".creationFee"),
            vm.parseJsonUint(json, ".graduationFeeBps")
        );
        vm.deal(treasury, 0);

        delete users;
        delete tokens;
        uint256 userCount = vm.parseJsonUint(json, ".users");
        for (uint256 i; i < userCount; ++i) {
            address u = makeAddr(string.concat("parity-user-", vm.toString(i)));
            vm.deal(u, USER_FUNDS);
            users.push(u);
        }

        uint256[] memory flat = vm.parseJsonUintArray(json, ".flat");
        for (uint256 i; i + 4 < flat.length; i += 5) {
            uint256 code = _exec(flat[i], flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4]);
            vm.writeLine(out, this.stateLine(code));
        }
    }

    // ─── Execution ────────────────────────────────────────────────────────

    /// @return 0 on success, else the error's shared code.
    function _exec(uint256 kind, uint256 u, uint256 t, uint256 a, uint256 b) internal returns (uint256) {
        if (kind == CREATE) return _create(users[u], a, b);
        if (kind == BUY) {
            vm.prank(users[u]);
            try pad.buy{value: a}(tokens[t], b, users[u]) returns (uint256) {
                return 0;
            } catch (bytes memory err) {
                return _code(err);
            }
        }
        if (kind == SELL) {
            vm.prank(users[u]);
            try pad.sell(tokens[t], a, b, users[u]) returns (uint256) {
                return 0;
            } catch (bytes memory err) {
                return _code(err);
            }
        }
        if (kind == AMM_BUY) {
            address[] memory path = _path(address(weth), tokens[t]);
            vm.prank(users[u]);
            try router.swapExactETHForTokens{value: a}(b, path, users[u], type(uint256).max) returns (
                uint256[] memory
            ) {
                return 0;
            } catch (bytes memory err) {
                return _code(err);
            }
        }
        if (kind == AMM_SELL) {
            address[] memory path = _path(tokens[t], address(weth));
            vm.prank(users[u]);
            try router.swapExactTokensForETH(a, b, path, users[u], type(uint256).max) returns (uint256[] memory) {
                return 0;
            } catch (bytes memory err) {
                return _code(err);
            }
        }
        if (kind == GRADUATE) {
            try pad.graduate(tokens[t]) {
                return 0;
            } catch (bytes memory err) {
                return _code(err);
            }
        }
        if (kind == SET_TRADE_FEE || kind == SET_GRAD_FEE || kind == SET_CREATION_FEE) return _setFee(kind, a);
        revert("ZecParity: unknown op kind");
    }

    function _create(address user, uint256 value, uint256 minTokensOut) internal returns (uint256) {
        vm.prank(user);
        try pad.create{value: value}("Parity", "PAR", "ipfs://parity", minTokensOut) returns (address token) {
            tokens.push(token);
            // Standing approvals, so every later sell can pull tokens. The
            // engine has no approvals; this only removes a difference that
            // isn't under test.
            for (uint256 i; i < users.length; ++i) {
                vm.startPrank(users[i]);
                MemeToken(token).approve(address(pad), type(uint256).max);
                MemeToken(token).approve(address(router), type(uint256).max);
                vm.stopPrank();
            }
            return 0;
        } catch (bytes memory err) {
            return _code(err);
        }
    }

    function _setFee(uint256 kind, uint256 value) internal returns (uint256) {
        vm.prank(owner);
        if (kind == SET_TRADE_FEE) {
            try pad.setTradeFeeBps(value) {
                return 0;
            } catch (bytes memory err) {
                return _code(err);
            }
        }
        if (kind == SET_GRAD_FEE) {
            try pad.setGraduationFeeBps(value) {
                return 0;
            } catch (bytes memory err) {
                return _code(err);
            }
        }
        try pad.setCreationFee(value) {
            return 0;
        } catch (bytes memory err) {
            return _code(err);
        }
    }

    /// @dev Error selector to the shared code in zec/engine/errors.ts. Errors
    ///      with the same signature share a selector across contracts, so
    ///      the router's, pair's and library's InsufficientOutputAmount are
    ///      all code 10. 99 means an error the engine has no mapping for.
    function _code(bytes memory err) internal pure returns (uint256) {
        if (err.length < 4) return 99;
        bytes4 sel = bytes4(err);
        if (sel == UnderwaterLaunchpad.ZeroAmount.selector) return 1;
        if (sel == UnderwaterLaunchpad.UnknownToken.selector) return 2;
        if (sel == UnderwaterLaunchpad.AlreadyGraduated.selector) return 3;
        if (sel == UnderwaterLaunchpad.SlippageExceeded.selector) return 4;
        if (sel == UnderwaterLaunchpad.InsufficientBalance.selector) return 5;
        if (sel == UnderwaterLaunchpad.NotGraduated.selector) return 6;
        if (sel == UnderwaterLaunchpad.InsufficientCreationFee.selector) return 7;
        if (sel == UnderwaterLaunchpad.EmptyMetadata.selector) return 8;
        if (sel == UnderwaterLaunchpad.FeeTooHigh.selector) return 9;
        if (sel == UnderwaterRouter.InsufficientOutputAmount.selector) return 10;
        if (sel == UnderwaterLibrary.InsufficientLiquidity.selector) return 11;
        if (sel == UnderwaterLibrary.InsufficientInputAmount.selector) return 12;
        if (sel == UnderwaterLibrary.PairNotFound.selector) return 13;
        return 99;
    }

    // ─── State capture ────────────────────────────────────────────────────

    /// @notice One JSON array of decimal strings, laid out as `stateVector` in
    ///         zec/parity/ops.ts: outcome, fee recipient, total curve ETH,
    ///         each user's ETH then token balances, then each token's curve,
    ///         pool and supply.
    /// @dev External so each line is built in its own frame and its memory is
    ///      released once written.
    function stateLine(uint256 code) external view returns (string memory s) {
        s = string.concat("[\"", vm.toString(code), "\"");
        s = _num(s, treasury.balance);
        s = _num(s, pad.totalCurveEth());
        for (uint256 u; u < users.length; ++u) {
            s = _num(s, users[u].balance);
            for (uint256 t; t < tokens.length; ++t) {
                s = _num(s, MemeToken(tokens[t]).balanceOf(users[u]));
            }
        }
        for (uint256 t; t < tokens.length; ++t) {
            s = _pool(s, tokens[t]);
        }
        s = string.concat(s, "]");
    }

    function _pool(string memory s, address token) internal view returns (string memory) {
        (bool ok, bytes memory data) = address(pad).staticcall(abi.encodeCall(pad.pools, (token)));
        require(ok, "ZecParity: pools() failed");
        PoolView memory p = abi.decode(data, (PoolView));
        s = _num(s, p.ethReserve);
        s = _num(s, p.tokenReserve);
        s = _num(s, p.realEthRaised);
        s = _num(s, p.tokensSold);
        s = _num(s, p.graduated ? 1 : 0);
        (uint256 ammQuote, uint256 ammToken) = _amm(token);
        s = _num(s, ammQuote);
        s = _num(s, ammToken);
        return _num(s, MemeToken(token).totalSupply());
    }

    /// @return quote WETH-side reserve, token token-side reserve; zeros before graduation.
    function _amm(address token) internal view returns (uint256 quote, uint256 tokenReserve) {
        address pair = factory.getPair(token, address(weth));
        if (pair == address(0)) return (0, 0);
        (uint112 r0, uint112 r1,) = UnderwaterPair(pair).getReserves();
        return UnderwaterPair(pair).token0() == address(weth) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _num(string memory s, uint256 v) internal pure returns (string memory) {
        return string.concat(s, ",\"", vm.toString(v), "\"");
    }

    function _path(address from, address to) internal pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = from;
        path[1] = to;
    }
}
