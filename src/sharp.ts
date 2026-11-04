// A taker that picks off stale quotes: bun src/sharp.ts. A maker's quote goes stale the moment the price moves, until
// the maker re-quotes. This bot takes any quote a move has left on the wrong side of the price, through the same
// public streams and orders as anyone, so that quoting on Rizon works like quoting anywhere: a slow quote costs you.
// Settings: RIZON_URL, RIZON_KEY or MAKER_FILE (src/rizon.ts), SHARP_SIZE ($25: enough to hurt a stale quote, not enough to drain a maker's paper), SHARP_EDGE (6¢ per $1).
import type { Market, Side } from './api.ts';
import { Rest, resolveKey } from './rizon.ts';

/** Φ(z), the standard normal CDF (Abramowitz and Stegun 26.2.17: good to 7 decimals). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const p = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) * p;
  return z >= 0 ? 1 - tail : tail;
}

export interface Take {
  side: Side;
  strike: number;
  /** What it expects to make per $1: 2 × its chance of winning − 1. */
  edge: number;
}

/**
 * The quote worth taking now, if any. Buying from the ask at k wins if the number ends above k, so its chance is
 * Φ((spot − k) ÷ sigma), with sigma the market's one-sigma move over its horizon; selling into the bid mirrors it.
 */
export function staleQuote(spot: number, sigma: number, bid: number | null, ask: number | null, minEdge: number): Take | null {
  if (!(sigma > 0)) return null;
  const edge = (past: number) => 2 * normalCdf(past / sigma) - 1;
  const up: Take | null = ask === null ? null : { side: 'up', strike: ask, edge: edge(spot - ask) };
  const down: Take | null = bid === null ? null : { side: 'down', strike: bid, edge: edge(bid - spot) };
  const best = !up || (down && down.edge > up.edge) ? down : up;
  return best && best.edge >= minEdge ? best : null;
}

const COOLDOWN_MS = 2_000;
const RELIST_MS = 30_000;

async function main(): Promise<void> {
  const url = (process.env.RIZON_URL ?? 'https://rizon.markets').replace(/\/$/, '');
  const size = Number(process.env.SHARP_SIZE ?? 25);
  const minEdge = Number(process.env.SHARP_EDGE ?? 0.06);
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} sharp: ${line}`);
  let key: string | null = null;
  for (let wait = 1_000; !key; wait = Math.min(wait * 2, 30_000)) {
    try {
      key = (await resolveKey({ url, key: process.env.RIZON_KEY, file: process.env.MAKER_FILE ?? 'sharp.json', botKey: process.env.BOT_KEY, name: 'SHARP-BOT', log })).key;
    } catch (err) {
      log(`${(err as Error).message}; retrying in ${wait / 1000}s`);
      await Bun.sleep(wait);
    }
  }
  const rest = new Rest(url, key);
  // the price books: the only ones whose number moves faster than a maker can re-read it
  const list = async () => (await rest.markets()).filter((m) => m.kind === 'rolling' && m.unit === 'usd' && m.status !== 'closed');
  let markets: Market[] = [];
  for (; !markets.length; await Bun.sleep(1_000)) markets = await list().catch(() => []);
  setInterval(() => void list().then((m) => (markets = m)).catch(() => {}), RELIST_MS);

  const spots = new Map<string, { price: number; live: boolean }>();
  const tops = new Map<string, { bid: number | null; ask: number | null }>();
  const last = new Map<string, number>();
  let taken = 0;
  let filled = 0;
  setInterval(() => {
    log(`${taken} orders, ${filled} fills in the last 5 minutes`);
    taken = filled = 0;
  }, 300_000);

  const connect = () => {
    const channels = [...new Set(markets.map((m) => `price:${m.underlying}`)), ...markets.map((m) => `book:${m.id}`)];
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/v1/ws?channels=${channels.join(',')}&key=${key}`);
    const scan = (underlying: string) => {
      const spot = spots.get(underlying);
      if (!spot?.live) return;
      for (const m of markets) {
        const top = tops.get(m.id);
        if (m.underlying !== underlying || !top || Date.now() - (last.get(m.id) ?? 0) < COOLDOWN_MS) continue;
        const take = staleQuote(spot.price, m.sigma, top.bid, top.ask, minEdge);
        if (!take) continue;
        last.set(m.id, Date.now());
        taken++;
        ws.send(JSON.stringify({ type: 'place', reqId: `${m.id}-${Date.now()}`, market: m.id, side: take.side, strike: take.strike, size, tif: 'ioc' }));
      }
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { type: string; data: { underlying: string; price: number; live: boolean; market: string; bids: { strike: number }[]; asks: { strike: number }[]; positions?: unknown[] } };
      if (msg.type === 'price') {
        spots.set(msg.data.underlying, { price: msg.data.price, live: msg.data.live });
        scan(msg.data.underlying);
      } else if (msg.type === 'book') {
        tops.set(msg.data.market, { bid: msg.data.bids[0]?.strike ?? null, ask: msg.data.asks[0]?.strike ?? null });
        const m = markets.find((x) => x.id === msg.data.market);
        if (m) scan(m.underlying);
      } else if (msg.type === 'ack') {
        filled += msg.data.positions?.length ?? 0;
      }
    };
    ws.onclose = () => setTimeout(connect, 2_000);
  };
  connect();
  log(`${url}: ${markets.map((m) => m.id).join(', ')}, $${size} a take, from ${Math.round(minEdge * 100)}¢ per $1`);
}

if (import.meta.main) void main();
