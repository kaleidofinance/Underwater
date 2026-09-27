import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpWallet } from "../rails/http-wallet.ts";

interface Seen {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/** A fake wallet service: records each request and answers from a route table. */
function fakeService(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method, url, auth: headers.get("authorization"), body });
    const path = new URL(url).pathname + new URL(url).search;
    const handler = routes[`${method} ${path}`];
    const [status, json] = handler ? handler(body) : [404, { error: "no route" }];
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

test("HttpWallet speaks the service's wire format: bearer auth, decimal-string amounts", async () => {
  const { seen, fetchImpl } = fakeService({
    "GET /tip": () => [200, { height: 4397048 }],
    "GET /address/7": () => [200, { index: 7, address: "utest1abc" }],
    "GET /incoming?from=100": () => [
      200,
      [{ id: "aa:orchard:0", txid: "aa", addressIndex: 7, amount: "123456789012345678", height: 101 }],
    ],
    "GET /spendable": () => [200, { zats: "900000000" }],
    "POST /validate": () => [200, { valid: true }],
    "POST /prepare": () => [200, { txid: "bb", fee: "15000" }],
    "POST /broadcast": () => [200, { ok: true }],
    "GET /status/bb": () => [200, { state: "mined", height: 102 }],
  });
  const w = new HttpWallet({ url: "https://wallet.example/", token: "t0ken", fetch: fetchImpl });

  assert.equal(await w.tip(), 4397048);
  assert.equal(await w.addressAt(7), "utest1abc");
  const [note] = await w.incoming(100);
  assert.equal(note?.amount, 123456789012345678n, "amounts come back as exact bigints");
  assert.equal(await w.spendable(), 900000000n);
  assert.equal(await w.validateAddress("utest1x"), true);
  assert.deepEqual(await w.prepare([{ address: "utest1dest", amount: 100_000_000n }]), { txid: "bb", fee: 15_000n });
  await w.broadcast("bb");
  assert.deepEqual(await w.status("bb"), { state: "mined", height: 102 });

  assert.ok(seen.every((s) => s.auth === "Bearer t0ken"), "every call is authenticated");
  assert.equal(seen[0]?.url, "https://wallet.example/tip", "trailing slash trimmed");
  const prepare = seen.find((s) => s.url.endsWith("/prepare"));
  assert.deepEqual(prepare?.body, { outputs: [{ address: "utest1dest", amount: "100000000" }] });
});

test("HttpWallet surfaces the service's error message", async () => {
  const { fetchImpl } = fakeService({
    "POST /prepare": () => [422, { error: "proposal failed: InsufficientFunds { available: 0, required: 110000 }" }],
    "GET /tip": () => [401, { error: "unauthorized" }],
  });
  const w = new HttpWallet({ url: "https://wallet.example", token: "wrong", fetch: fetchImpl });
  await assert.rejects(w.prepare([{ address: "utest1dest", amount: 1n }]), /422 proposal failed: InsufficientFunds/);
  await assert.rejects(w.tip(), /401 unauthorized/);
  await assert.rejects(w.addressAt(-1), RangeError);
});
