// Polymarket's books as they change, over its public market WebSocket (no key). Subscribing to a token sends its
// book; after that every change comes as a price_change carrying the token's new best bid and ask, and every trade
// as a last_trade_price. The Gamma API still says which markets an event has (src/sources/polymarket.ts); this
// keeps their quotes current between its reads, so a model can re-quote within a second of a move rather than at
// its next poll. While the socket is down nothing here is used: the quotes fall back to Gamma's.
// Docs: https://docs.polymarket.com (WSS, market channel)
import type { PmEvent } from './polymarket.ts';

export const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
/** The server drops a quiet connection: a PING this often keeps it open (it answers PONG). */
const PING_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

/** A token's best quotes (0-1), null for an empty side, and its last trade. */
export interface Top {
  bid: number | null;
  ask: number | null;
  last: number | null;
}

/** What a model needs of the feed (a fake in tests). */
export interface LiveFeed {
  /** Follows these tokens for owner (replacing what it followed before), calling fn when any of their quotes changes. */
  watch(owner: object, tokens: readonly string[], fn: () => void): void;
  unwatch(owner: object): void;
  /** The token's quotes, once its book has come in on the current connection. */
  top(token: string): Top | null;
}

const price = (x: unknown): number | null => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
/** Polymarket shows an empty side as 0 (bid) or 1 (ask). */
const bidOf = (x: unknown) => {
  const p = price(x);
  return p !== null && p > 0 ? p : null;
};
const askOf = (x: unknown) => {
  const p = price(x);
  return p !== null && p < 1 ? p : null;
};

export class PmLive implements LiveFeed {
  private ws: WebSocket | null = null;
  private open = false;
  private readonly owners = new Map<object, { tokens: Set<string>; fn: () => void }>();
  /** Every token some owner follows, and the ones the socket has been asked for. */
  private subscribed = new Set<string>();
  private readonly tops = new Map<string, Top>();
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1_000;

  constructor(
    private readonly url = CLOB_WS,
    private readonly log: (line: string) => void = () => {},
  ) {}

  watch(owner: object, tokens: readonly string[], fn: () => void): void {
    this.owners.set(owner, { tokens: new Set(tokens), fn });
    const fresh = tokens.filter((t) => !this.subscribed.has(t));
    if (!fresh.length) return;
    for (const t of fresh) this.subscribed.add(t);
    if (this.open) this.ws!.send(JSON.stringify({ assets_ids: fresh, operation: 'subscribe' }));
    else if (!this.ws && !this.retry) this.connect();
  }

  unwatch(owner: object): void {
    this.owners.delete(owner);
    // a token nobody follows stays subscribed until the next connection; with no owner left, the socket closes
    if (this.owners.size) return;
    this.subscribed.clear();
    this.close();
  }

  top(token: string): Top | null {
    return this.open ? (this.tops.get(token) ?? null) : null;
  }

  close(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.drop();
    ws?.close(1000);
  }

  private drop(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.ws = null;
    this.open = false;
    this.tops.clear();
  }

  private connect(): void {
    // the tokens still followed: one that nobody follows any more is left out of the new connection
    this.subscribed = new Set([...this.owners.values()].flatMap((o) => [...o.tokens]));
    if (!this.subscribed.size) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.open = true;
      this.backoff = 1_000;
      ws.send(JSON.stringify({ assets_ids: [...this.subscribed], type: 'market' }));
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('PING'), PING_MS);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const text = String(e.data);
      if (text === 'PONG') return;
      try {
        this.handle(JSON.parse(text));
      } catch (err) {
        this.log(`polymarket socket: bad message: ${(err as Error).message}`);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      const tokens = [...this.subscribed];
      this.drop();
      // quotes fall back to Gamma's meanwhile: let the owners re-view now rather than keep the socket's last ones
      this.notify(tokens);
      if (!this.owners.size) return;
      this.log(`polymarket socket closed (${e.code}); reconnecting in ${this.backoff / 1000}s`);
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
  }

  /** One message: a book, an array of books (the answer to a subscription), a price_change or a last_trade_price. */
  handle(msg: unknown): void {
    const changed: string[] = [];
    for (const x of (Array.isArray(msg) ? msg : [msg]) as Record<string, unknown>[]) {
      const kind = x?.event_type;
      if (kind === 'book') {
        const levels = (side: unknown) => (Array.isArray(side) ? (side as { price: unknown; size: unknown }[]).filter((l) => (price(l.size) ?? 0) > 0).map((l) => price(l.price)!) : []);
        const bids = levels(x.bids).filter((p) => p > 0);
        const asks = levels(x.asks).filter((p) => p < 1);
        const t = String(x.asset_id);
        this.tops.set(t, { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null, last: this.tops.get(t)?.last ?? null });
        changed.push(t);
      } else if (kind === 'price_change' && Array.isArray(x.price_changes)) {
        for (const c of x.price_changes as Record<string, unknown>[]) {
          const t = String(c.asset_id);
          const was = this.tops.get(t);
          // only a token whose book has come in: a change alone says nothing about the other side's depth
          if (!was) continue;
          this.tops.set(t, { ...was, bid: bidOf(c.best_bid), ask: askOf(c.best_ask) });
          changed.push(t);
        }
      } else if (kind === 'last_trade_price') {
        const t = String(x.asset_id);
        const was = this.tops.get(t);
        if (was) {
          this.tops.set(t, { ...was, last: price(x.price) });
          changed.push(t);
        }
      }
    }
    this.notify(changed);
  }

  private notify(tokens: readonly string[]): void {
    if (!tokens.length) return;
    for (const o of this.owners.values()) if (tokens.some((t) => o.tokens.has(t))) o.fn();
  }
}

/** The one socket every model shares. */
export const pmLive = new PmLive(CLOB_WS, (line) => console.log(`${new Date().toISOString().slice(11, 19)} bots: ${line}`));

/** The event with each market's quotes from the socket, where it has them (Gamma's elsewhere). */
export function withLive(ev: PmEvent, feed: LiveFeed): PmEvent {
  return {
    ...ev,
    markets: ev.markets.map((m) => {
      const t = m.token ? feed.top(m.token) : null;
      return t ? { ...m, bid: t.bid, ask: t.ask, last: t.last ?? m.last } : m;
    }),
  };
}
