/**
 * The pre-launch waitlist: X handle, optional email, referral points.
 *
 * Kept apart from the engine's log on purpose: it's marketing, not money,
 * and nothing in it should ever be able to affect a balance. Each sign-up
 * is tied to the browser account key the person will trade with, so at
 * launch their points are already on their account.
 *
 * Points: 100 for joining, 50 for every person who joins with your link.
 * Handles are self-declared (checking them would need X's API), so points
 * are screened for fake sign-ups before they count toward anything.
 *
 * Storage is an append-only JSON-lines file, fsynced, replayed on start.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { EngineError } from "../engine/index.ts";

export const JOIN_POINTS = 100;
export const REFERRAL_POINTS = 50;
/** Sign-ups one client IP may make in a day: enough for a household, not a farm. */
export const SIGNUPS_PER_IP_PER_DAY = 3;

export interface Entry {
  readonly account: string;
  readonly handle: string;
  readonly email: string | null;
  readonly code: string;
  readonly referredBy: string | null;
  readonly at: number;
}

export interface Standing {
  readonly code: string;
  readonly handle: string;
  readonly rank: number;
  readonly points: number;
  readonly referrals: number;
  readonly joinedAt: number;
}

type Line = ({ t: "join" } & Entry) | { t: "email"; account: string; email: string | null };

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class Waitlist {
  readonly #file: string | null;
  readonly #byAccount = new Map<string, Entry>();
  readonly #byCode = new Map<string, Entry>();
  readonly #handles = new Set<string>();
  readonly #emails = new Set<string>();
  readonly #referrals = new Map<string, number>();
  /** Recent sign-ups per hashed client IP. Hashed with a per-process salt: raw IPs are never kept. */
  readonly #recentByClient = new Map<string, number[]>();
  readonly #salt = randomBytes(16);
  #ranked: Standing[] | null = null;

  constructor(file: string | null) {
    this.#file = file;
    if (file && existsSync(file)) {
      for (const raw of readFileSync(file, "utf8").split("\n")) {
        if (!raw.trim()) continue;
        try {
          this.#apply(JSON.parse(raw) as Line);
        } catch {
          // A torn last line from a crash mid-write: everything before it stands.
        }
      }
    }
  }

  get size(): number {
    return this.#byAccount.size;
  }

  /**
   * Join, or return your standing if you already have. Joining twice changes
   * nothing but the email, if one is given.
   */
  join(args: { account: string; handle: string; email?: string | null; ref?: string | null; client: string; now: number }): Standing {
    const existing = this.#byAccount.get(args.account);
    const email = normaliseEmail(args.email);
    if (existing) {
      if (args.email !== undefined && email !== existing.email) {
        if (email && this.#emails.has(email)) throw new EngineError("DuplicateId", "that email is already on the list");
        this.#write({ t: "email", account: existing.account, email });
      }
      return this.standing(existing.code) as Standing;
    }

    const handle = args.handle.trim().replace(/^@/, "");
    if (!HANDLE.test(handle)) throw new EngineError("InvalidArgument", "an X handle is 1-15 letters, numbers or underscores");
    if (this.#handles.has(handle.toLowerCase())) throw new EngineError("DuplicateId", `@${handle} is already on the list`);
    if (email && this.#emails.has(email)) throw new EngineError("DuplicateId", "that email is already on the list");

    const client = createHash("sha256").update(this.#salt).update(args.client).digest("hex");
    const recent = (this.#recentByClient.get(client) ?? []).filter((t) => t > args.now - 86_400_000);
    if (recent.length >= SIGNUPS_PER_IP_PER_DAY) throw new EngineError("LimitExceeded", "too many sign-ups from this network today");
    recent.push(args.now);
    this.#recentByClient.set(client, recent);

    const referrer = args.ref ? this.#byCode.get(args.ref.trim().toUpperCase()) : undefined;
    const entry: Entry = {
      account: args.account,
      handle,
      email,
      code: this.#newCode(),
      referredBy: referrer && referrer.account !== args.account ? referrer.code : null,
      at: args.now,
    };
    this.#write({ t: "join", ...entry });
    return this.standing(entry.code) as Standing;
  }

  standingOf(account: string): Standing | null {
    const e = this.#byAccount.get(account);
    return e ? this.standing(e.code) : null;
  }

  standing(code: string): Standing | null {
    return this.#rank().find((s) => s.code === code.toUpperCase()) ?? null;
  }

  top(n: number): Standing[] {
    return this.#rank().slice(0, n);
  }

  /** Everything, emails included: for the operator only. */
  export(): Array<Entry & { points: number; rank: number }> {
    const ranks = new Map(this.#rank().map((s) => [s.code, s]));
    return [...this.#byAccount.values()].map((e) => {
      const s = ranks.get(e.code);
      return { ...e, points: s?.points ?? 0, rank: s?.rank ?? 0 };
    });
  }

  #rank(): Standing[] {
    if (!this.#ranked) {
      this.#ranked = [...this.#byAccount.values()]
        .map((e) => {
          const referrals = this.#referrals.get(e.code) ?? 0;
          return { code: e.code, handle: e.handle, points: JOIN_POINTS + referrals * REFERRAL_POINTS, referrals, joinedAt: e.at, rank: 0 };
        })
        .sort((a, b) => b.points - a.points || a.joinedAt - b.joinedAt)
        .map((s, i) => ({ ...s, rank: i + 1 }));
    }
    return this.#ranked;
  }

  #newCode(): string {
    for (;;) {
      const bytes = randomBytes(6);
      const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
      if (!this.#byCode.has(code)) return code;
    }
  }

  #write(line: Line): void {
    if (this.#file) {
      const fd = openSync(this.#file, "a");
      try {
        writeSync(fd, `${JSON.stringify(line)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.#apply(line);
  }

  #apply(line: Line): void {
    this.#ranked = null;
    if (line.t === "join") {
      const { t: _, ...entry } = line;
      this.#byAccount.set(entry.account, entry);
      this.#byCode.set(entry.code, entry);
      this.#handles.add(entry.handle.toLowerCase());
      if (entry.email) this.#emails.add(entry.email);
      if (entry.referredBy) this.#referrals.set(entry.referredBy, (this.#referrals.get(entry.referredBy) ?? 0) + 1);
      return;
    }
    const e = this.#byAccount.get(line.account);
    if (!e) return;
    if (e.email) this.#emails.delete(e.email);
    if (line.email) this.#emails.add(line.email);
    const next = { ...e, email: line.email };
    this.#byAccount.set(e.account, next);
    this.#byCode.set(e.code, next);
  }
}

function normaliseEmail(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new EngineError("InvalidArgument", "that doesn't look like an email address");
  return email;
}
