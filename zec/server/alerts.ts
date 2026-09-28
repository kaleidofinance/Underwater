/**
 * Alerts that reach a human, not just the logs.
 *
 * Everything goes to the console. If configured, alerts are also sent to a
 * Telegram chat (ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID) and/or a
 * webhook (ALERT_WEBHOOK_URL, Discord- and Slack-compatible). The rails
 * re-raise a stuck condition every tick, so a repeat of the same text is held
 * back for `repeatMs`; a critical alert always goes out.
 */

export type AlertLevel = "info" | "warn" | "critical";

export interface AlerterOptions {
  readonly telegramToken?: string;
  readonly telegramChatId?: string;
  readonly webhookUrl?: string;
  /** Prefix on every message, e.g. "[testnet]". */
  readonly label?: string;
  readonly repeatMs?: number;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
}

export class Alerter {
  readonly #o: AlerterOptions;
  readonly #lastSent = new Map<string, number>();
  readonly #now: () => number;
  readonly #fetch: typeof fetch;

  constructor(options: AlerterOptions = {}) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, label?: string): Alerter {
    return new Alerter({
      telegramToken: env.ALERT_TELEGRAM_BOT_TOKEN,
      telegramChatId: env.ALERT_TELEGRAM_CHAT_ID,
      webhookUrl: env.ALERT_WEBHOOK_URL,
      label,
    });
  }

  /** Whether anything beyond the console is configured. */
  get routed(): boolean {
    return Boolean((this.#o.telegramToken && this.#o.telegramChatId) || this.#o.webhookUrl);
  }

  /** Send `text`. Returns whether it went out (false when held back as a repeat). Never throws. */
  async send(level: AlertLevel, text: string): Promise<boolean> {
    const line = `${this.#o.label ? `${this.#o.label} ` : ""}${level.toUpperCase()} ${text}`;
    (this.#o.log ?? console.warn)(line);
    const now = this.#now();
    const last = this.#lastSent.get(text);
    if (level !== "critical" && last !== undefined && now - last < (this.#o.repeatMs ?? 30 * 60_000)) return false;
    this.#lastSent.set(text, now);
    if (this.#lastSent.size > 500) this.#lastSent.delete(this.#lastSent.keys().next().value as string);

    const icon = level === "critical" ? "🚨" : level === "warn" ? "⚠️" : "ℹ️";
    const message = `${icon} ${line}`;
    const sends: Promise<unknown>[] = [];
    if (this.#o.telegramToken && this.#o.telegramChatId) {
      sends.push(
        this.#post(`https://api.telegram.org/bot${this.#o.telegramToken}/sendMessage`, {
          chat_id: this.#o.telegramChatId,
          text: message,
          disable_web_page_preview: true,
        }),
      );
    }
    if (this.#o.webhookUrl) sends.push(this.#post(this.#o.webhookUrl, { content: message, text: message }));
    await Promise.all(sends);
    return true;
  }

  async #post(url: string, body: unknown): Promise<void> {
    try {
      await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // An alert channel being down must never take the server with it.
      console.error(`alert delivery failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Watches the rails loop and turns its state into alerts: every rails alert,
 * a run of failed ticks (the wallet or lightwalletd is down), the recovery
 * after one, and ZEC missing from the wallet with nothing in flight.
 */
export class RailsWatch {
  readonly #alerter: Alerter;
  #failures = 0;
  readonly #failAfter: number;

  constructor(alerter: Alerter, failAfter = 3) {
    this.#alerter = alerter;
    this.#failAfter = failAfter;
  }

  async tickOk(alerts: readonly string[]): Promise<void> {
    if (this.#failures >= this.#failAfter) await this.#alerter.send("info", `rails recovered after ${this.#failures} failed ticks`);
    this.#failures = 0;
    for (const a of alerts) await this.#alerter.send(a.startsWith("reorg") || a.startsWith("PAUSED") || a.startsWith("GUARD") ? "critical" : "warn", a);
  }

  async tickFailed(message: string): Promise<void> {
    this.#failures++;
    if (this.#failures === this.#failAfter) {
      await this.#alerter.send("critical", `rails failing ${this.#failures} ticks in a row: ${message}`);
    }
  }

  async reconciled(r: { expected: bigint; actual: bigint; drift: bigint; inFlight: number }): Promise<void> {
    if (r.drift < 0n && r.inFlight === 0) {
      await this.#alerter.send("critical", `ZEC MISSING: wallet holds ${r.actual} zats, ledger expects ${r.expected} (drift ${r.drift})`);
    }
  }
}
