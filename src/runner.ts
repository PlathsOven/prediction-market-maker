// The runner: one account that quotes every open market it has a model for, through the public API only.
//
// It lists the markets (the markets channel the moment one opens or closes, and GET /markets every 5 s), makes a
// model for each one it knows (src/markets.ts), and keeps one WebSocket open for prices and its own orders,
// positions and account. Feed markets (and ELON's count) re-quote on every price; polled models (another venue, a
// status page, a post history) every 45-60 s, when what they read changes. Each re-quote is one batch (POST
// /orders/batch over the socket): the quotes that moved are canceled and their replacements placed inside the
// exchange's order limit, a side with nothing resting first (every book two-sided before any gets its depth), then
// best levels first; a feed book's side that a move left safer may lag a little (src/ladder.ts sticky), and slower
// books leave room for faster ones. A rolling book whose number isn't live is held as it is (the exchange soon
// takes no orders on it either). Quotes on a market it doesn't quote (no longer listed, or no model) come down. On a long-dated
// market it stops adding to a side once its net position there passes a cap. Stopping cancels every quote.
import { type Account, type BatchResult, type Market, type Order, type OrderRequest, type Position, type ServerMsg, isOpen, kindOf } from './api.ts';
import { fmtStrike, fmtValue } from './format.ts';
import { jdnOf } from './grid.ts';
import { type Quote, type Resting, plan, stickiness, sticky } from './ladder.ts';
import { type Deps, createModel } from './markets.ts';
import { DistModel, type Model, STALE_LIMIT_MS, STALE_MS, type Sizing, type Target, type Tick, hold, none } from './models/model.ts';
import type { Rest } from './rizon.ts';

export interface RunnerOptions {
  rest: Rest;
  sizing: Sizing;
  /** Feed markets (BTC, Gold): dollars a level and levels a side, over each calibration's own. */
  feed?: { size?: number; levels?: number };
  /** Which listed markets to quote. */
  allow: (m: Market) => boolean;
  /** On a long-dated market (fixed, date, or a horizon of an hour or more): the largest net size, up − down, it holds. */
  maxNet: number;
  log: (line: string) => void;
  /** A line for every re-quote, feed markets too (they re-quote many times a second). */
  verbose: boolean;
  /** Makes a market's model (src/markets.ts createModel unless given: tests use their own). */
  create?: (m: Market, deps: Deps) => Model | null;
  /** Quote rolling markets whose number isn't live instead of holding them (an exchange that trades on stand-in values). */
  quoteNotLive?: boolean;
}

/** A book is re-quoted at most this often. */
const MIN_REQUOTE_MS = 100;
/** Orders a second it allows itself, under the exchange's limit. */
const ORDER_MARGIN = 2;
/**
 * Orders a second each kind of book leaves free for faster ones, so a 15-second book's re-quote never waits behind a
 * slower book's: 1-minute feed books leave 4, longer feed books 6, polled markets 8.
 */
const reserveOf = (m: Market, model: Model): number => (!model.follows ? 8 : (m.horizon ?? Infinity) <= 15 ? 0 : (m.horizon ?? Infinity) <= 60 ? 4 : 6);
const BATCH_MAX = 20;
/** A polled model with nothing to quote from yet (its first read failed) tries again this soon. */
const FIRST_READ_RETRY_MS = 10_000;
const BATCH_CANCEL_MAX = 100;
const MARKETS_MS = 5_000;
/** An order counts against its budget this long: the exchange's 1 s window, plus slack for the trip. */
const BUDGET_WINDOW_MS = 1_100;
const REPORT_MS = 30_000;
/** How often it logs how long re-quotes take, per market. */
const LATENCY_REPORT_MS = 5 * 60_000;

const longDated = (m: Market) => kindOf(m) !== 'rolling' || (m.horizon ?? 0) >= 3600;
const jitter = (ms: number) => Math.round(ms * (0.9 + 0.2 * Math.random()));

export class Runner {
  private ws: WebSocket | null = null;
  private backoff = 1_000;
  private stopped = false;
  private markets = new Map<string, Market>();
  private models = new Map<string, Model>();
  private polls = new Map<Model, ReturnType<typeof setTimeout> | null>();
  private skipped = new Set<string>();
  private ticks = new Map<string, Tick>();
  private resting = new Map<string, Resting>();
  private open = new Map<string, { market: string; side: 'up' | 'down'; size: number }>();
  private lastQuote = new Map<string, number>();
  private memo = new Map<string, { stamp: string; target: Target }>();
  private said = new Map<string, string>();
  private placedAt: number[] = [];
  private budget = 20 - ORDER_MARGIN;
  private inFlight: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private intervals: ReturnType<typeof setInterval>[] = [];
  private seq = 0;
  private acct: Account | null = null;
  private channels = new Set<string>();
  private stats = { batches: 0, placed: 0, canceled: 0, fills: 0, refused: 0 };
  private lastRefusal = '';
  /** The markets of the orders in the batch in flight, in order, to tell which market a refusal was for. */
  private sent: string[] = [];
  /** A market whose orders were refused waits before it's quoted again: 5 s, doubling to a minute while it's refused. */
  private cooldown = new Map<string, { until: number; ms: number }>();
  /** Since when a market's book has differed from its target (a price moved, a source changed). */
  private dirtySince = new Map<string, number>();
  /** How long each market's book took to match a new target, last 200 re-quotes (ms). */
  private readonly latencies = new Map<string, number[]>();
  /** The sigma each feed book quotes with: it follows the listing's only once that's 10% away (see target()). */
  private sigmas = new Map<string, number>();

  constructor(private readonly o: RunnerOptions) {}

  async start(): Promise<void> {
    this.budget = Math.max(1, (await this.o.rest.ordersPerSecond().catch(() => 20)) - ORDER_MARGIN);
    await this.refreshMarkets();
    this.intervals.push(setInterval(() => void this.refreshMarkets(), MARKETS_MS));
    this.intervals.push(setInterval(() => this.report(), REPORT_MS));
    this.intervals.push(setInterval(() => this.reportLatency(), LATENCY_REPORT_MS));
    this.connect();
  }

  /** Cancels every quote (and anything else resting on the account) and closes. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const i of this.intervals) clearInterval(i);
    for (const t of this.polls.values()) if (t) clearTimeout(t);
    this.ws?.close(1000);
    const n = await this.o.rest.cancelAll().catch(() => null);
    this.o.log(n === null ? 'stopped (cancel-all failed)' : `stopped: canceled ${n} quotes`);
  }

  private async refreshMarkets(): Promise<void> {
    const list = await this.o.rest.markets().catch(() => null);
    if (list) this.setMarkets(list);
  }

  /** The markets as the exchange lists them: models for new ones, none for ones that are gone. */
  private setMarkets(list: Market[]): void {
    const allowed = list.filter(this.o.allow);
    this.markets = new Map(allowed.map((m) => [m.id, m]));
    for (const m of allowed) {
      if (this.models.has(m.id) || this.skipped.has(m.id)) continue;
      const model = (this.o.create ?? createModel)(m, this.deps(m.id));
      if (!model) {
        this.skipped.add(m.id);
        this.o.log(`${m.id}: no model for ${m.underlying}, not quoting it`);
        continue;
      }
      this.models.set(m.id, model);
      this.o.log(`${m.id}: quoting from ${model.source}`);
      if (model.refresh) this.poll(model);
    }
    for (const [id, model] of [...this.models]) {
      if (this.markets.has(id)) continue;
      this.models.delete(id);
      const t = this.polls.get(model);
      if (t) clearTimeout(t);
      this.polls.delete(model);
    }
    // an underlying with a price channel takes its prices from there; the others from each listing
    const followed = new Set(this.priceChannels().map((c) => c.slice('price:'.length)));
    for (const m of allowed) {
      if (m.spot === null || (followed.has(m.underlying) && this.ticks.has(m.underlying))) continue;
      this.ticks.set(m.underlying, { price: m.spot, live: m.live, at: Date.now() });
    }
    const wanted = this.priceChannels();
    const missing = wanted.filter((c) => !this.channels.has(c));
    if (missing.length && this.ws?.readyState === WebSocket.OPEN) {
      for (const c of missing) this.channels.add(c);
      this.ws.send(JSON.stringify({ type: 'subscribe', channels: missing }));
    }
    this.later(0);
  }

  private deps(id: string): Deps {
    return {
      sizing: this.o.sizing,
      feed: this.o.feed,
      quoteNotLive: this.o.quoteNotLive,
      listing: () => this.markets.get(id)!,
    };
  }

  /**
   * Refreshes a polled model now and then every pollMs (with jitter), re-quoting after each read; until its first
   * good read (a source down at boot), every 10 s.
   */
  private poll(model: Model): void {
    const run = async () => {
      if (this.stopped || !this.polls.has(model)) return;
      await model.refresh!(Date.now());
      this.later(0);
      const waiting = model instanceof DistModel && model.readAt === -Infinity;
      if (!this.stopped && this.polls.has(model)) this.polls.set(model, setTimeout(run, jitter(waiting ? FIRST_READ_RETRY_MS : (model.pollMs ?? 45_000))));
    };
    this.polls.set(model, null);
    void run();
  }

  /** The price channels of the underlyings its models follow (only ones the exchange lists: an unknown channel is refused). */
  private priceChannels(): string[] {
    const us = new Set<string>();
    for (const [id, model] of this.models) if (model.follows) us.add(this.markets.get(id)!.underlying);
    return [...us].map((u) => `price:${u}`);
  }

  private connect(): void {
    if (this.stopped) return;
    const prices = this.priceChannels();
    // with no channel named the server sends every stream; with no price to follow, ask for a quiet one
    const channels = prices.length ? prices : ['leaderboard'];
    this.channels = new Set(channels);
    const url = `${this.o.rest.api.replace(/^http/, 'ws')}/ws?channels=${channels.join(',')}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.o.rest.key}` } } as unknown as string[]);
    this.ws = ws;
    ws.onmessage = (e) => {
      try {
        this.handle(JSON.parse(String(e.data)) as ServerMsg);
      } catch (err) {
        this.o.log(`bad message: ${(err as Error).message}`);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.inFlight = null;
      if (this.stopped) return;
      this.o.log(`socket closed (${e.code}); reconnecting in ${this.backoff / 1000}s`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
  }

  private handle(m: ServerMsg): void {
    switch (m.type) {
      case 'hello': {
        this.backoff = 1_000;
        this.channels = new Set(m.data.channels);
        this.setMarkets(m.data.markets);
        for (const mk of m.data.markets) if (mk.spot !== null) this.ticks.set(mk.underlying, { price: mk.spot, live: mk.live, at: Date.now() });
        // quotes and positions left from before (a restart): adopted, then re-quoted like any other
        this.resting.clear();
        for (const o of m.data.orders) this.track(o);
        this.open.clear();
        for (const p of m.data.positions) this.position(p);
        this.acct = m.data.account;
        this.o.log(`connected as ${m.data.account?.name ?? '?'}: ${this.resting.size} quotes resting, ${this.open.size} positions open`);
        // the moment a market opens or closes (an exchange without the channel answers with an error, ignored)
        this.ws?.send(JSON.stringify({ type: 'subscribe', reqId: 'markets', channels: ['markets'] }));
        return this.requote();
      }
      case 'markets':
        return this.setMarkets(m.data);
      case 'price':
        this.ticks.set(m.data.underlying, { price: m.data.price, live: m.data.live, at: Date.now() });
        return this.requote();
      case 'order':
        return this.track(m.data);
      case 'position':
        if (m.data.result === null && !this.open.has(m.data.id)) this.stats.fills++;
        this.position(m.data);
        return;
      case 'account':
        this.acct = m.data;
        return;
      case 'ack':
        if (m.reqId === this.inFlight) this.applied(m.data as BatchResult);
        return;
      case 'error':
        if (m.reqId === this.inFlight) {
          this.inFlight = null;
          this.refused(m.data.error);
          // the whole batch was refused (rate, or a malformed request): wait a moment before the next
          this.later(m.status === 429 ? 1_000 : 250);
        }
        return;
    }
  }

  private track(o: Order): void {
    if (o.status === 'open' && o.strike !== null) {
      this.resting.set(o.id, { id: o.id, market: o.market, side: o.side, strike: o.strike, remaining: o.size - o.filled });
    } else this.resting.delete(o.id);
  }

  private position(p: Position): void {
    if (p.result === null) this.open.set(p.id, { market: p.market, side: p.side, size: p.size });
    else this.open.delete(p.id);
  }

  private applied(r: BatchResult): void {
    this.inFlight = null;
    for (const o of r.canceled) this.resting.delete(o.id);
    this.stats.canceled += r.canceled.length;
    const refusedIn = new Set<string>();
    const placedIn = new Set<string>();
    r.results.forEach((res, i) => {
      if ('order' in res) {
        this.track(res.order);
        for (const o of res.canceled) this.resting.delete(o.id);
        for (const p of res.positions) this.position(p);
        placedIn.add(this.sent[i]);
      } else {
        this.refused(res.error);
        if (this.sent[i]) refusedIn.add(this.sent[i]);
      }
    });
    const now = Date.now();
    for (const m of placedIn) this.cooldown.delete(m);
    for (const m of refusedIn) {
      if (placedIn.has(m)) continue;
      const ms = Math.min(60_000, (this.cooldown.get(m)?.ms ?? 2_500) * 2);
      this.cooldown.set(m, { until: now + ms, ms });
    }
    this.later(0);
  }

  private refused(error: string): void {
    this.stats.refused++;
    if (error !== this.lastRefusal) this.o.log(`refused: ${error}`);
    this.lastRefusal = error;
  }

  private later(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.requote();
    }, ms);
  }

  /** Net size held on a market: up positions minus down positions, dollars. */
  private net(market: string): number {
    let n = 0;
    for (const p of this.open.values()) if (p.market === market) n += p.side === 'up' ? p.size : -p.size;
    return n;
  }

  /** What market m should rest now: the model's ladder, unless the market isn't open, less a side its net position caps. */
  private target(m: Market, model: Model, now: number): Target {
    if (!isOpen(m)) return none(`market ${m.status}`);
    // a rolling contract records the underlying's value at its fill: until there is one the exchange takes no orders
    if (kindOf(m) === 'rolling' && !this.ticks.has(m.underlying)) return none('no price yet');
    // nor (soon) while that value isn't live (a feed down, a status page or a counter not read lately): what rests
    // is held as it is, and re-quoted when it's back
    const last = this.ticks.get(m.underlying);
    if (kindOf(m) === 'rolling' && !this.o.quoteNotLive && !(m.live && (last?.live ?? true))) return hold('price not live', last?.price ?? m.spot ?? 0);
    const net = longDated(m) ? this.net(m.id) : 0;
    const cap = net >= this.o.maxNet ? 'up' : net <= -this.o.maxNet ? 'down' : '';
    // a polled model's ladder only changes when it reads (or holds a read), as it goes stale, at midnight (date
    // strikes), or when the listing does
    const stale = model instanceof DistModel ? (now - model.readAt > STALE_LIMIT_MS ? 2 : now - model.readAt > STALE_MS ? 1 : 0) : 0;
    // (one that follows a price, as ELON's count, also when the price does)
    const tick = model.follows ? this.ticks.get(m.underlying) : undefined;
    const stamp =
      model instanceof DistModel
        ? `${model.readAt}:${model.held}:${stale}:${jdnOf(now)}:${m.status}:${m.live}:${m.strikeMin}:${m.strikeMax}:${cap}:${tick ? `${tick.price}:${tick.live}` : ''}`
        : null;
    const hit = stamp === null ? undefined : this.memo.get(m.id);
    if (hit && hit.stamp === stamp) return hit.target;
    // a feed ladder's widths and level spacing round off sigma: a sigma wobbling across a rounding edge would move
    // every outer level each time, so a book keeps its sigma until the listing's is 10% away
    const held = this.sigmas.get(m.id);
    const sigma = held !== undefined && m.sigma > 0 && Math.abs(m.sigma - held) <= 0.1 * held ? held : m.sigma;
    if (model.follows) this.sigmas.set(m.id, sigma);
    let t = model.target(model.follows ? { ...m, sigma } : m, now, this.ticks.get(m.underlying));
    if (cap) t = { ...t, quotes: t.quotes.filter((q) => q.side !== cap), reason: `net ${net > 0 ? 'up' : 'down'} $${Math.abs(net).toFixed(0)}: no more ${cap === 'up' ? 'bids' : 'asks'}` };
    if (stamp !== null) this.memo.set(m.id, { stamp, target: t });
    return t;
  }

  /**
   * One batch across every book due a re-quote: cancels first, then new quotes within the order budget. A side
   * left with nothing resting gets its best quote first, every book's before any book's depth (and inside no
   * reserve): a book is two-sided as soon as it can be. Then the fastest books first, each leaving its reserve.
   */
  private requote(): void {
    if (this.inFlight || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    this.placedAt = this.placedAt.filter((t) => now - t < BUDGET_WINDOW_MS);
    let room = Math.min(BATCH_MAX, this.budget - this.placedAt.length);
    const cancel: string[] = [];
    const orders: (Quote & { market: string })[] = [];
    const lines: string[] = [];
    let wait = Infinity;
    // quotes in a market it doesn't quote (any more) come down
    for (const o of this.resting.values()) if (!this.models.has(o.market) && cancel.length < BATCH_CANCEL_MAX) cancel.push(o.id);
    // the fastest books first: they're the ones a stale quote costs
    const books = [...this.markets.values()].filter((m) => this.models.has(m.id)).sort((a, b) => (a.horizon ?? Infinity) - (b.horizon ?? Infinity));
    const due: { m: Market; model: Model; target: Target; place: Quote[]; canceled: number; cooling: boolean; first: Quote[] }[] = [];
    for (const m of books) {
      const model = this.models.get(m.id)!;
      // refused a moment ago: it still cancels what's off its target (a stale quote never waits), but places nothing yet
      const cool = this.cooldown.get(m.id);
      const cooling = cool !== undefined && now < cool.until;
      if (cooling) wait = Math.min(wait, cool.until - now);
      const since = now - (this.lastQuote.get(m.id) ?? -Infinity);
      if (since < MIN_REQUOTE_MS) {
        wait = Math.min(wait, MIN_REQUOTE_MS - since);
        continue;
      }
      const target = this.target(m, model, now);
      this.say(m, target);
      // its price is down: the exchange takes no orders on it, so what rests stays as it is until it's back
      if (target.hold) {
        this.dirtySince.delete(m.id);
        continue;
      }
      const resting = [...this.resting.values()].filter((o) => o.market === m.id);
      // a feed book's side that a move left safer may lag a little: wiggles of a strike cost no orders
      const { slack, tolerance } = stickiness(this.sigmas.get(m.id) ?? m.sigma, m.strikeStep);
      const want = model.follows && target.quotes.length ? sticky(target.quotes, resting, m.strikeStep, slack, tolerance) : target.quotes;
      const p = plan(want, resting, target.center);
      if (!p.cancel.length && !p.place.length) {
        const since = this.dirtySince.get(m.id);
        if (since !== undefined) {
          this.dirtySince.delete(m.id);
          const list = this.latencies.get(m.id) ?? [];
          list.push(now - since);
          if (list.length > 200) list.shift();
          this.latencies.set(m.id, list);
        }
        continue;
      }
      if (!this.dirtySince.has(m.id)) this.dirtySince.set(m.id, now);
      if (cancel.length + p.cancel.length > BATCH_CANCEL_MAX) break;
      cancel.push(...p.cancel);
      // a side with nothing left resting once this batch's cancels are done: its best quote goes first
      const gone = new Set(p.cancel);
      const first = (['up', 'down'] as const).flatMap((side) => {
        const left = resting.some((o) => o.side === side && !gone.has(o.id));
        const best = p.place.find((q) => q.side === side);
        return !left && best ? [best] : [];
      });
      due.push({ m, model, target, place: p.place, canceled: p.cancel.length, cooling, first });
      this.lastQuote.set(m.id, now);
    }
    const placed = new Map<string, number>();
    const add = (m: Market, qs: Quote[]) => {
      orders.push(...qs.map((q) => ({ ...q, market: m.id })));
      room -= qs.length;
      placed.set(m.id, (placed.get(m.id) ?? 0) + qs.length);
    };
    for (const d of due) if (!d.cooling && d.first.length) add(d.m, d.first.slice(0, Math.max(0, room)));
    for (const d of due) {
      const done = new Set(orders.filter((o) => o.market === d.m.id).map((o) => `${o.side}:${o.strike}`));
      const rest = d.place.filter((q) => !done.has(`${q.side}:${q.strike}`));
      // a slower book's placements never eat into what the faster ones keep for their next move
      const share = Math.min(room, this.budget - reserveOf(d.m, d.model) - this.placedAt.length - orders.length);
      if (!d.cooling) add(d.m, rest.slice(0, Math.max(0, share)));
      const n = placed.get(d.m.id) ?? 0;
      // what didn't fit goes out on the next re-quote
      if (n < d.place.length && !d.cooling) wait = Math.min(wait, BUDGET_WINDOW_MS - (now - (this.placedAt[0] ?? now)));
      if ((n || d.canceled) && (!d.model.follows || this.o.verbose)) lines.push(this.line(d.m, d.target, n, d.canceled));
    }
    if (!cancel.length && !orders.length) {
      if (wait < Infinity) this.later(Math.max(10, wait));
      return;
    }
    const reqId = `q${++this.seq}`;
    this.inFlight = reqId;
    this.sent = orders.map((q) => q.market);
    this.stats.batches++;
    this.stats.placed += orders.length;
    for (let i = 0; i < orders.length; i++) this.placedAt.push(now);
    this.ws.send(
      JSON.stringify({
        type: 'batch',
        reqId,
        ...(cancel.length && { cancel }),
        ...(orders.length && { orders: orders.map((q): OrderRequest => ({ market: q.market, side: q.side, size: q.size, strike: q.strike })) }),
      }),
    );
    for (const l of lines) this.o.log(l);
  }

  /** One line per re-quote: the centre, the best bid and ask, what moved. */
  private line(m: Market, t: Target, placed: number, canceled: number): string {
    const bids = t.quotes.filter((q) => q.side === 'up');
    const asks = t.quotes.filter((q) => q.side === 'down');
    const best = (qs: Quote[], side: 'up' | 'down') =>
      qs.length ? fmtStrike(m.unit, side === 'up' ? Math.max(...qs.map((q) => q.strike)) : Math.min(...qs.map((q) => q.strike))) : '—';
    const centre = t.quotes.length || t.reason ? `${centreName(m)} ${fmtValue(m.unit, t.center)} · ` : '';
    return `${m.id}: ${centre}bid ${best(bids, 'up')} · ask ${best(asks, 'down')} · ${bids.length}+${asks.length} levels · placed ${placed}, canceled ${canceled}${t.reason ? ` (${t.reason})` : ''}`;
  }

  /** Says once why a market isn't (fully) quoted or is quoted wider, and again when that changes. */
  private say(m: Market, t: Target): void {
    const why = `${t.reason ?? ''}|${t.note ?? ''}`;
    const before = this.said.get(m.id);
    if (before === why) return;
    this.said.set(m.id, why);
    if (t.reason) this.o.log(`${m.id}: ${t.quotes.length ? 'one-sided' : t.hold ? 'held' : 'not quoting'}: ${t.reason}`);
    if (t.note) this.o.log(`${m.id}: ${t.note}`);
    else if (before?.split('|')[1] && !t.hold) this.o.log(`${m.id}: back to its usual width`);
  }

  /** p50 and p90 of how long each market's book took to match a new target, since the last report. */
  private reportLatency(): void {
    const parts: string[] = [];
    for (const [id, list] of [...this.latencies.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!list.length) continue;
      const s = [...list].sort((a, b) => a - b);
      parts.push(`${id} ${s[Math.floor(s.length / 2)]}/${s[Math.floor(s.length * 0.9)]} ms (${s.length})`);
      this.latencies.set(id, []);
    }
    if (parts.length) this.o.log(`re-quote latency p50/p90: ${parts.join(' · ')}`);
  }

  private report(): void {
    const s = this.stats;
    const a = this.acct;
    const money = a ? ` · balance $${a.balance.toFixed(0)}, in orders $${a.inOrders.toFixed(0)}, pnl $${a.pnl.toFixed(2)}, rank ${a.rank ?? '-'}` : '';
    this.o.log(`${this.resting.size} quotes on ${this.models.size} markets · last 30 s: ${s.batches} batches, ${s.placed} placed, ${s.canceled} canceled, ${s.fills} fills, ${s.refused} refused${money}`);
    this.stats = { batches: 0, placed: 0, canceled: 0, fills: 0, refused: 0 };
  }
}

/** What a market's ladder centres on: the feed's spot, or the implied median. */
const centreName = (m: Market) => (kindOf(m) === 'rolling' && m.unit !== 'uptime' ? 'spot' : 'median');
