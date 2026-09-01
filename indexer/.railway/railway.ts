/**
 * The Railway project, in code.
 *
 * Replaces `indexer/railway.json`. Config as Code is deprecated and stops being read on
 * 2026-12-01, and the replacement is not the same shape: `railway.json` described one
 * service's deploy settings, where this describes the **whole project**. `railway config
 * plan` diffs it against what is live and `railway config apply` moves Railway to match.
 *
 * Which is why the database and its volume are declared here even though nothing about
 * them changed. A resource missing from this file is a resource Railway is being told it
 * may remove, so the file was produced with `railway config pull` — importing what is
 * actually running — rather than hand-written from the seven settings `railway.json` had.
 * The Postgres holding every indexed row is not a thing to leave to a typed guess.
 *
 * Variables are `preserve()`: the names are declared, the values stay in Railway.
 * `railway config pull --include-variables` would have decrypted `DATABASE_URL` and the
 * RPC endpoint into a tracked file, so it was not used. Adding a variable means adding a
 * `preserve()` line here and setting the value with `railway variable set`.
 *
 * Every `railway` command has to run from `indexer/` — the project link is keyed to the
 * directory `railway init` ran in.
 */
import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "ams" });

  const postgresVolume = volume("postgres-volume", {
    sizeMB: 500,
    region: "ams",
    allowOnlineResize: true,
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  });

  const indexer = service("indexer", {
    /**
     * Five of the seven settings `railway.json` carried. None of them came back from
     * `config pull`, because Railway read that file per deploy instead of storing it in
     * the service — the deployment metadata still shows each one attributed to
     * `$.deploy.startCommand` and friends rather than held on the service. So this is the
     * part of the migration that had to be done by hand, and the part worth checking
     * against the plan. The other two were the restart policy; see below for why they are
     * not here.
     */
    build: { builder: "NIXPACKS" },
    start: "npm start",
    /**
     * `/health`, not `/ready`. Ponder answers `/health` as soon as the process is
     * listening and `/ready` only once the backfill is finished — a full Ink Sepolia
     * backfill takes about 100 seconds, so a deploy gated on `/ready` would fail this
     * 60-second check every time. Nothing is lost by not gating on it: the app's own
     * adapter reads `/ready` on every request and falls back to RPC while it is 503, so
     * the half-indexed window is handled where it can be handled per query.
     */
    healthcheck: "/health",
    healthcheckTimeout: 60,

    // No `deploy` block, and the omission is the considered answer rather than the leftover
    // one. `railway.json` also asked for `restartPolicyType: "ON_FAILURE"` with 10 retries;
    // that is still what runs, but it runs because it is Railway's default. The proof is in
    // this same project — Postgres has never had a config file and resolves to exactly
    // `ON_FAILURE` / 10, while its `startCommand` and `healthcheckPath` resolve to `null`.
    //
    // And Railway keeps a default-valued field unset, so declaring the policy does not
    // stick: `apply` reports success, the service still reads back unset, and the next
    // `plan` proposes the identical change again, forever. A file that never converges is
    // worse than one that leaves out a setting it cannot own — the phantom diff hides real
    // ones, and the pinned-plan CI flow in ./README.md would ship a no-op on every merge.
    //
    // The intent, for whoever reads this after a crash: the indexer should restart, because
    // one that stays down leaves every route on its RPC fallback indefinitely, which is
    // slower and — for points — wrong. Ten tries is far enough. If the policy ever needs to
    // stop being the default (`ALWAYS`, or a different retry count) it becomes a real diff
    // and a `deploy: {}` block belongs here.

    /**
     * One. `railway.json` said `numReplicas: 1` and it was not arbitrary: the indexer is
     * a single forward-only writer per Postgres schema, not a pool that shares work. The
     * pulled form names the region because that is how the live service is placed.
     */
    replicas: { ams: 1 },
    env: {
      DATABASE_URL: preserve(),
      /** The deploy slot. Rotated by hand per release — see the README. */
      DATABASE_SCHEMA: preserve(),
      INK_SEPOLIA_RPC_URL: preserve(),
      LAUNCHPAD_INK_SEPOLIA: preserve(),
      WAITLIST_INK_SEPOLIA: preserve(),
      POINTS_INK_SEPOLIA: preserve(),
      START_BLOCK_INK_SEPOLIA: preserve(),
      POINTS_FROM_BLOCK_INK_SEPOLIA: preserve(),
    },
  });

  return project("underwater-indexer", {
    resources: [indexer, Postgres, postgresVolume],
  });
});
