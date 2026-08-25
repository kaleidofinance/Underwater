"use client";

import type { Address } from "viem";
import { useReadContract } from "wagmi";
import { platesAbi } from "@/lib/abis";
import { useTokenMeta } from "@/lib/metadata";

/**
 * One plate, as the chain draws it.
 *
 * There is no image host to point at: `tokenURI` composes a base64 JSON document
 * with the SVG inlined, at read time, from the health factor of whatever position
 * the holder attached. So this reads the contract and hands the result to the same
 * resolver the launchpad's token art uses — a `data:` URI needs no gateway, and
 * the `image` field inside it is another `data:` URI.
 *
 * Three things can leave nothing to show, and they are different: no renderer has
 * been set yet (the read reverts), the read is still in flight, or the plate was
 * drowned and burned. The caption says which rather than showing an empty frame.
 */
export function PlateArt({
  plates,
  id,
  size = 132,
}: {
  plates: Address;
  id: bigint;
  size?: number;
}) {
  const {
    data: uri,
    isLoading,
    isError,
  } = useReadContract({
    address: plates,
    abi: platesAbi,
    functionName: "tokenURI",
    args: [id],
    // The art moves only when the position behind it does, and a freshly minted
    // plate is in dry dock. No poll — the page refetches the collection instead.
    query: { staleTime: 30_000 },
  });

  const { meta, isLoading: resolving } = useTokenMeta(uri as string | undefined);

  return (
    <figure style={{ margin: 0, width: size }}>
      {meta?.image ? (
        // A plain `<img>`, like TokenArt: the source is a data URI the contract
        // built, which next/image cannot optimise and has no reason to.
        <img
          className="art"
          src={meta.image}
          width={size}
          height={size}
          style={{ width: size, height: size }}
          alt={meta.name ?? `Plate ${id}`}
        />
      ) : (
        <div
          className="art"
          style={{
            width: size,
            height: size,
            display: "grid",
            placeItems: "center",
            fontFamily: "var(--mono)",
            fontSize: 8.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--ink-faint)",
            textAlign: "center",
            padding: 8,
          }}
        >
          {isLoading || resolving ? "drawing…" : isError ? "no renderer" : "—"}
        </div>
      )}
      <figcaption
        className="row-sub"
        style={{ marginTop: 6, textAlign: "center" }}
      >
        #{String(id)}
      </figcaption>
    </figure>
  );
}
