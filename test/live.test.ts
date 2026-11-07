// Polymarket's socket (src/sources/polymarket-live.ts) against a local server speaking its market channel, and an
// event model streaming a game's lines through a fake feed, on the Detroit at Miami event recorded 2026-11-07.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { normCdf } from '../src/dist.ts';
import { LADDER } from '../src/ladder.ts';
import { EventModel, LIVE_MS } from '../src/models/event.ts';
import type { Sizing } from '../src/models/model.ts';
import { type LiveFeed, PmLive, type Top } from '../src/sources/polymarket-live.ts';
import { parsePmEvent } from '../src/sources/polymarket.ts';

const until = async (ok: () => boolean, ms = 3_000) => {
  for (const t0 = Date.now(); !ok(); await Bun.sleep(10)) if (Date.now() - t0 > ms) throw new Error('timed out');
};

describe('the socket', () => {
  // the server: a book for each token asked for (on connecting or later), PONG to PING
  const asked: string[][] = [];
  const sockets = new Set<import('bun').ServerWebSocket<unknown>>();
  const book = (t: string) => ({ event_type: 'book', asset_id: t, bids: [{ price: '0.5', size: '10' }, { price: '0.52', size: '5' }, { price: '0.53', size: '0' }], asks: [{ price: '0.6', size: '3' }, { price: '0.54', size: '7' }] });
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      open: (ws) => void sockets.add(ws),
      close: (ws) => void sockets.delete(ws),
      message(ws, raw) {
        if (raw === 'PING') return void ws.send('PONG');
        const m = JSON.parse(String(raw)) as { assets_ids: string[] };
        asked.push(m.assets_ids);
        ws.send(JSON.stringify(m.assets_ids.map(book)));
      },
    },
  });
  const send = (msg: unknown) => {
    for (const ws of sockets) ws.send(JSON.stringify(msg));
  };
  afterAll(() => {
    void server.stop(true);
  });

  test('books, then each change and trade, for the tokens followed; more tokens on the open socket; down means no quotes, then back', async () => {
    const live = new PmLive(`ws://localhost:${server.port}`);
    let a = 0;
    let b = 0;
    const one = {};
    const two = {};
    live.watch(one, ['A'], () => a++);
    await until(() => live.top('A') !== null);
    // the best bid with size (0.53 has none) and the best ask
    expect(live.top('A')).toEqual({ bid: 0.52, ask: 0.54, last: null });
    expect(a).toBe(1);

    send({ event_type: 'price_change', price_changes: [{ asset_id: 'A', best_bid: '0.55', best_ask: '0.56' }, { asset_id: 'Z', best_bid: '0.1', best_ask: '0.2' }] });
    await until(() => live.top('A')!.bid === 0.55);
    expect(live.top('A')!.ask).toBe(0.56);
    // a token it never had a book for is left alone
    expect(live.top('Z')).toBeNull();
    send({ event_type: 'last_trade_price', asset_id: 'A', price: '0.555' });
    await until(() => live.top('A')!.last === 0.555);
    // an emptied side is null, not 0 or 1
    send({ event_type: 'price_change', price_changes: [{ asset_id: 'A', best_bid: '0', best_ask: '1' }] });
    await until(() => live.top('A')!.bid === null);
    expect(live.top('A')!.ask).toBeNull();

    // a second owner's token goes out on the same connection
    live.watch(two, ['A', 'B'], () => b++);
    await until(() => live.top('B') !== null);
    expect(asked).toEqual([['A'], ['B']]);
    expect(sockets.size).toBe(1);

    // the server drops us: no quotes (Gamma's serve), everyone told; a second later it's back with fresh books
    const before = a;
    for (const ws of sockets) ws.close();
    await until(() => live.top('A') === null && a > before);
    await until(() => live.top('A') !== null && live.top('B') !== null, 4_000);
    expect(asked.at(-1)!.sort()).toEqual(['A', 'B']);

    // with nobody following, the socket closes
    live.unwatch(one);
    expect(sockets.size).toBe(1);
    live.unwatch(two);
    await until(() => sockets.size === 0);
    expect(live.top('A')).toBeNull();
  });
});

describe('a streaming game', () => {
  const pm = `${import.meta.dir}/fixtures/polymarket-nfl-det-mia-2026-11-08.json`;
  const ks = `${import.meta.dir}/fixtures/kalshi-nfl-spread.json`;
  const real = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      const file = u.includes('gamma-api.polymarket.com') ? pm : u.includes('kalshi.com') ? ks : null;
      return file ? new Response(await Bun.file(file).text()) : new Response('not found', { status: 404 });
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = real;
  });

  class Fake implements LiveFeed {
    tops = new Map<string, Top>();
    tokens: string[] = [];
    fn: (() => void) | null = null;
    watch(_o: object, tokens: readonly string[], fn: () => void) {
      this.tokens = [...tokens];
      this.fn = fn;
    }
    unwatch() {
      this.fn = null;
    }
    top(t: string) {
      return this.tops.get(t) ?? null;
    }
  }
  const sizing: Sizing = { ladder: LADDER, thinMargin: 0.07 };

  test('follows only its own lines, mixes in Kalshi while the socket is quiet, then reads the socket alone, a score within a second', async () => {
    const feed = new Fake();
    const model = new EventModel(
      [
        { venue: 'polymarket', slug: 'nfl-det-mia-2026-11-08', shape: 'margin', home: 'Lions', sigma: 13.5 },
        { venue: 'kalshi', event: 'KXNFLSPREAD-26NOV08DETMIA', home: 'DET' },
      ],
      { value: { type: 'continuous' }, support: [-70, 70] },
      sizing,
      [],
      undefined,
      feed,
    );
    model.guards = { scale: 7, sane: [-70, 70] };
    let woke = 0;
    model.listen(() => woke++);
    await model.refresh(Date.now());

    // the margin's lines: 34 spreads and the moneyline, none of the totals
    const ev = parsePmEvent(JSON.parse(await Bun.file(pm).text()));
    const margin = ev.markets.filter((m) => m.type === 'spreads' || m.type === 'moneyline');
    expect(feed.tokens.sort()).toEqual(margin.map((m) => m.token!).sort());
    // nothing on the socket yet: both venues, half each
    expect(model.built!.reports.slice(0, 2).map((r) => r.weight)).toEqual([0.5, 0.5]);
    const pre = model.built!.dist.median();
    expect(pre).toBeGreaterThan(6.5);
    expect(pre).toBeLessThan(7.5);

    // Miami scores: every line on the socket says the Lions' margin is 4 lower, normal around 2.8
    for (const m of margin) {
      const x = m.type === 'moneyline' ? 0 : -m.line!;
      const pAbove = 1 - normCdf((x - 2.8) / 13.5);
      const p = m.outcomes[0] === 'Lions' ? pAbove : normCdf((-x - 2.8) / 13.5);
      feed.tops.set(m.token!, { bid: p - 0.005, ask: p + 0.005, last: null });
    }
    feed.fn!();
    await Bun.sleep(LIVE_MS + 200);
    expect(woke).toBe(1);
    const b = model.built!;
    expect(b.dist.median()).toBeCloseTo(2.8, 0);
    // Polymarket alone makes the fair value; Kalshi, read before the score, is a check, and widens the quotes
    expect(b.reports[0].weight).toBe(1);
    expect(b.reports[1].weight).toBe(0);
    expect(b.reports[1].note).toContain('a check while Polymarket streams');
    expect(b.widen?.why).toContain('Kalshi');

    // a burst of changes is one re-view
    feed.fn!();
    feed.fn!();
    feed.fn!();
    await Bun.sleep(LIVE_MS + 200);
    expect(woke).toBe(2);
    model.close();
    expect(feed.fn).toBeNull();
  });
});
