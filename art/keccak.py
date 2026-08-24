#!/usr/bin/env python3
"""Keccak-256, the hash Solidity's `keccak256` computes.

Vendored rather than pulled from `pycryptodome`/`eth-hash` because the only caller
is `art/fixtures.py`, which runs in whatever bare Python a contributor has — the
same reason the rest of the toolchain avoids dependencies. This is Ethereum's
Keccak (padding byte 0x01), *not* NIST SHA3-256 (0x06); the two differ only in that
byte and produce entirely different digests, so the distinction is the whole point.

The fixtures use it to pin a 12 KB plate as a 32-byte digest the on-chain renderer
can reproduce with one `keccak256` call, instead of embedding the SVG twice.
"""

from __future__ import annotations

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]
_MASK = (1 << 64) - 1


def _rotl(x: int, n: int) -> int:
    return ((x << n) | (x >> (64 - n))) & _MASK


def _keccak_f(a: list[list[int]]) -> None:
    for rc in _RC:
        # Theta.
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rotl(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        # Rho and pi.
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rotl(a[x][y], _ROT[x][y])
        # Chi.
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        # Iota.
        a[0][0] ^= rc


def keccak256(data: bytes) -> bytes:
    """The 32-byte Keccak-256 digest of `data`."""
    rate = 136  # 1600-bit state minus the 512-bit capacity, in bytes
    a = [[0] * 5 for _ in range(5)]

    # Pad: append 0x01, zero-fill, set the top bit of the last rate byte.
    padded = bytearray(data)
    padded.append(0x01)
    while len(padded) % rate != 0:
        padded.append(0x00)
    padded[-1] |= 0x80

    for offset in range(0, len(padded), rate):
        block = padded[offset:offset + rate]
        for i in range(rate // 8):
            lane = int.from_bytes(block[i * 8:i * 8 + 8], "little")
            a[i % 5][i // 5] ^= lane
        _keccak_f(a)

    out = bytearray()
    for i in range(4):  # 32 bytes = 4 lanes off the top of the state
        out += a[i % 5][i // 5].to_bytes(8, "little")
    return bytes(out)


if __name__ == "__main__":
    # The empty-input digest, the standard smoke test that tells Keccak from SHA3.
    got = keccak256(b"").hex()
    want = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    print("ok" if got == want else f"FAIL {got}")
    assert got == want
