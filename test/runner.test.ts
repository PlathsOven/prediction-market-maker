// The runner against a stand-in for Rizon's API (REST and WebSocket, on a local port): it quotes BTC from the
// price channel within the order budget, re-quotes only what a move changes, holds a book while its price is
// down, makes every book two-sided before giving any its depth, takes down quotes on markets that close or that it
// has no model for, and cancels everything when it stops.
import { afterAll, afterEach, expect, test } from 'bun:test';
import type { Market, Order } from '../src/api.ts';
import { Dist } from '../src/dist.ts';
import { LADDER } from '../src/ladder.ts';
import { type Built, DistModel } from '../src/models/model.ts';
import { Rest } from '../src/rizon.ts';
import { Runner } from '../src/runner.ts';

const market = (m: Partial<Market> & { id: string }): Market => ({
  underlying: 'BTC-USD',
  horizon: 15,
  strikeStep: 1,
  strikeOffset: 0,
  spot: 100_000.4,
  live: true,
  bid: null,
  ask: null,
  bidSize: 0,
  askSize: 0,
  sigma: 31,
  kind: 'rolling',
  status: 'open',
  ...m,
});

let markets: Market[] = [
  market({ id: 'BTC-15s' }),
  market({ id: 'BTC-1m', horizon: 60, status: 'halted' }),
  market({ id: 'XYZ-2026', underlying: 'XYZ', horizon: null, kind: 'fixed', spot: null }),
];
const orders = new Map<string, Order>();
const batches: { cancel?: string[]; orders?: { market: string; side: string; strike: number; size: number }[] }[] = [];
let canceledAll = 0;
let channelsAsked = '';
let socket: { send(s: string): void } | null = null;
let n = 0;

const server = Bun.serve<{ channels: string }, never>({
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/api/v1/ws') {
      channelsAsked = url.searchParams.get('channels') ?? '';
      return srv.upgrade(req, { data: { channels: channelsAsked } }) ? undefined : new Response('no', { status: 400 });
    }
    if (url.pathname === '/api/v1') return Response.json({ rules: { ordersPerSecond: 20 } });
    if (url.pathname === '/api/v1/markets') return Response.json({ t: Date.now(), markets });
    if (url.pathname === '/api/v1/orders' && req.method === 'DELETE' && url.searchParams.get('all') === 'true') {
      canceledAll++;
      const canceled = [...orders.values()].map((o) => ({ ...o, status: 'canceled' }));
      orders.clear();
      return Response.json({ canceled });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
  websocket: {
    open(ws) {
      socket = ws;
      const account = { id: 'a1', name: 'TRADER-0001', rank: null, pnl: 0, balance: 1_000_000, inOrders: 0, inPositions: 0, equity: 1_000_000 };
      ws.send(JSON.stringify({ type: 'hello', data: { t: Date.now(), account, orders: [...orders.values()], positions: [], markets, channels: ws.data.channels.split(',') } }));
    },
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      if (m.type === 'subscribe') ws.send(JSON.stringify({ type: 'ack', reqId: m.reqId, status: 200, data: { channels: m.channels } }));
      if (m.type !== 'batch') return;
      batches.push(m);
      const canceled = (m.cancel ?? []).flatMap((id: string) => {
        const o = orders.get(id);
        if (!o) return [];
        orders.delete(id);
        return [{ ...o, status: 'canceled' }];
      });
      const results = (m.orders ?? []).map((o: { market: string; side: 'up' | 'down'; strike: number; size: number }) => {
        const order: Order = { id: `o${++n}`, clientId: null, market: o.market, side: o.side, strike: o.strike, size: o.size, filled: 0, status: 'open', createdAt: Date.now() };
        orders.set(order.id, order);
        return { status: 201, order, positions: [], canceled: [] };
      });
      ws.send(JSON.stringify({ type: 'ack', reqId: m.reqId, status: 200, data: { canceled, results } }));
    },
  },
});
afterAll(() => server.stop(true));
/** Every runner a test starts; stopped after it, pass or fail (one left running would keep the test run open). */
const started: Runner[] = [];
afterEach(async () => {
  for (const r of started.splice(0)) await r.stop().catch(() => {});
});
const track = (r: Runner) => (started.push(r), r);

const until = async (cond: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(20);
  return cond();
};

test('quotes BTC as the old maker did, re-quotes only what moves, skips what it can\'t quote, cancels all on stop', async () => {
  const lines: string[] = [];
  const runner = track(new Runner({
    rest: new Rest(`http://localhost:${server.port}`, 'rz_test'),
    sizing: { ladder: LADDER, thinMargin: 0.07 },
    allow: () => true,
    maxNet: 10_000,
    log: (l) => lines.push(l),
    verbose: false,
  }));
  await runner.start();

  // ten levels a side on BTC-15s; the budget (20 a second, less 2) splits them over two batches
  expect(await until(() => orders.size === 20)).toBe(true);
  expect(batches[0].orders).toHaveLength(18);
  expect(channelsAsked).toBe('price:BTC-USD');
  const book = [...orders.values()];
  expect(book.every((o) => o.market === 'BTC-15s' && o.size === 1_000)).toBe(true);
  const bestBid = Math.max(...book.filter((o) => o.side === 'up').map((o) => o.strike!));
  const bestAsk = Math.min(...book.filter((o) => o.side === 'down').map((o) => o.strike!));
  expect([bestBid, bestAsk]).toEqual([100_000, 100_001]);
  // nothing on a halted market, or one with no model
  expect(lines.some((l) => l.includes('XYZ-2026: no model'))).toBe(true);
  expect(lines.some((l) => l.includes('BTC-1m: not quoting: market halted'))).toBe(true);

  // a one-dollar move up: the asks (which it moved toward) move up, the best one off $100,001 and a new end at
  // $100,020 (outer levels every 2 strikes at this sigma); the bids, now further away, stay
  const before = batches.length;
  socket!.send(JSON.stringify({ type: 'price', data: { underlying: 'BTC-USD', t: Date.now(), price: 100_001.4, live: true } }));
  expect(await until(() => batches.length > before)).toBe(true);
  expect(batches[before].cancel).toHaveLength(1);
  expect(batches[before].orders).toEqual([{ market: 'BTC-15s', side: 'down', size: 1_000, strike: 100_020 }]);
  await Bun.sleep(200);
  expect(orders.size).toBe(20);
  // and straight back: both sides are now as far as the touch or a strike further, so nothing is re-quoted
  const after = batches.length;
  socket!.send(JSON.stringify({ type: 'price', data: { underlying: 'BTC-USD', t: Date.now(), price: 100_000.4, live: true } }));
  await Bun.sleep(300);
  expect(batches.length).toBe(after);

  await runner.stop();
  expect(canceledAll).toBe(1);
  expect(orders.size).toBe(0);
  expect(lines.at(-1)).toBe('stopped: canceled 20 quotes');
});

/** A model with no network: its view is fixed, spread evenly over 320-360. */
class Fixed extends DistModel {
  readonly source = 'a fixed view';
  protected async build(): Promise<Built> {
    return { dist: new Dist([], [{ lo: 319.5, hi: 359.5, p: 1 }]), thin: false, reports: [] };
  }
}
const fixed = (id: string, underlying: string, status: Market['status'] = 'open') =>
  market({ id, underlying, kind: 'fixed', horizon: null, spot: null, strikeStep: 1, strikeOffset: 0.5, strikeMin: 0.5, status });
const runnerWith = (create: (m: Market) => DistModel | null) =>
  track(new Runner({
    rest: new Rest(`http://localhost:${server.port}`, 'rz_test'),
    sizing: { ladder: LADDER, thinMargin: 0.07 },
    allow: () => true,
    maxNet: 10_000,
    log: () => {},
    verbose: false,
    create,
  }));
const on = (id: string) => [...orders.values()].filter((o) => o.market === id).length;

test('a market that closes (the markets channel) has its quotes down at once; one it has no model for, too', async () => {
  // a week left from before: its listing is closed, the bots have no model for it, and quotes of its still rest
  orders.clear();
  for (const strike of [330.5, 331.5]) {
    const o: Order = { id: `old${strike}`, clientId: null, market: 'ELON-W-2026-10-30', side: 'down', strike, size: 500, filled: 0, status: 'open', createdAt: 0 };
    orders.set(o.id, o);
  }
  markets = [fixed('ELON-W-2026-10-30', 'ELON-WEEK', 'closed'), fixed('EV-2026', 'EV')];
  const runner = runnerWith((m) => (m.underlying === 'EV' ? new Fixed({ ladder: LADDER, thinMargin: 0.07 }) : null));
  await runner.start();
  expect(await until(() => on('ELON-W-2026-10-30') === 0 && on('EV-2026') === 16)).toBe(true);
  await Bun.sleep(1_200);

  // the exchange closes a market it quotes and says so on the markets channel: the quotes come down well inside
  // the 5-second listing poll
  markets = [fixed('ELON-W-2026-10-30', 'ELON-WEEK', 'closed'), fixed('EV-2026', 'EV', 'closed')];
  const closed = Date.now();
  socket!.send(JSON.stringify({ type: 'markets', data: markets }));
  expect(await until(() => on('EV-2026') === 0, 500)).toBe(true);
  expect(Date.now() - closed).toBeLessThan(500);
  await runner.stop();
});

test('every book gets its best bid and ask before any book gets its depth', async () => {
  orders.clear();
  markets = Array.from({ length: 8 }, (_, i) => fixed(`EV-${i}`, `EV${i}`));
  const before = batches.length;
  const runner = runnerWith(() => new Fixed({ ladder: LADDER, thinMargin: 0.07 }));
  await runner.start();
  expect(await until(() => batches.length > before)).toBe(true);
  try {
    // the first batch: two quotes a book, the best of each side (over 320-360, the 46th and 54th percentiles: 337.5 and 341.5)
    const first = batches[before].orders!;
    expect(first).toHaveLength(16);
    for (const m of markets) {
      const mine = first.filter((o) => o.market === m.id).map((o) => `${o.side} ${o.strike}`);
      expect(mine.sort()).toEqual(['down 341.5', 'up 337.5']);
    }
  } finally {
    await runner.stop();
  }
});

test('a feed book is held while its price is down (nothing canceled, nothing placed), and re-quoted when it\'s back', async () => {
  orders.clear();
  markets = [market({ id: 'BTC-15s' })];
  const lines: string[] = [];
  const runner = track(new Runner({
    rest: new Rest(`http://localhost:${server.port}`, 'rz_test'),
    sizing: { ladder: LADDER, thinMargin: 0.07 },
    allow: () => true,
    maxNet: 10_000,
    log: (l) => lines.push(l),
    verbose: false,
  }));
  await runner.start();
  expect(await until(() => orders.size === 20)).toBe(true);
  await Bun.sleep(1_200);
  const before = batches.length;
  // the feed goes simulated, and its price wanders: the exchange takes no orders, the book stays as it was
  socket!.send(JSON.stringify({ type: 'price', data: { underlying: 'BTC-USD', t: Date.now(), price: 100_050.4, live: false } }));
  await Bun.sleep(300);
  expect(batches.length).toBe(before);
  expect(orders.size).toBe(20);
  expect(lines.some((l) => l.includes('BTC-15s: held: price not live: quotes left as they are'))).toBe(true);
  // back, $50 up: re-quoted around the new price
  socket!.send(JSON.stringify({ type: 'price', data: { underlying: 'BTC-USD', t: Date.now(), price: 100_050.4, live: true } }));
  expect(await until(() => batches.length > before)).toBe(true);
  expect(await until(() => [...orders.values()].some((o) => o.side === 'up' && o.strike === 100_050))).toBe(true);
  await runner.stop();
});

test('a feed book keeps its sigma until the listing\'s moves 10%: a wobble across a rounding edge moves nothing', async () => {
  // at sigma 24.9 the outer levels sit round(6% × 24.9) = 1 strike apart, at 25.1 two: the edge is 25
  markets = [market({ id: 'BTC-15s', sigma: 24.9 })];
  orders.clear();
  const runner = track(new Runner({
    rest: new Rest(`http://localhost:${server.port}`, 'rz_test'),
    sizing: { ladder: LADDER, thinMargin: 0.07 },
    allow: () => true,
    maxNet: 10_000,
    log: () => {},
    verbose: false,
  }));
  await runner.start();
  expect(await until(() => orders.size === 20)).toBe(true);
  await Bun.sleep(1_200);
  const before = batches.length;
  markets = [market({ id: 'BTC-15s', sigma: 25.1 })];
  socket!.send(JSON.stringify({ type: 'markets', data: markets }));
  await Bun.sleep(400);
  expect(batches.length).toBe(before);
  // a real change (over 10%) that widens the touch past what the book tolerates does move the ladder: at sigma
  // 48 the touch is 2 strikes, so the best bid steps a strike away, and a book that sigma leaves no slack nearer
  markets = [market({ id: 'BTC-15s', sigma: 48 })];
  socket!.send(JSON.stringify({ type: 'markets', data: markets }));
  expect(await until(() => batches.length > before, 2_000)).toBe(true);
  await runner.stop();
});
