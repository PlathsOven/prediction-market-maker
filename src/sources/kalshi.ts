// Kalshi, read through its public market-data API (no key): GET /events/<ticker>?with_nested_markets=true returns
// the event and its markets, each with structured strikes (floor_strike, cap_strike, strike_type), so nothing is
// parsed from text. Prices are dollars per contract (0-1) for the Yes side. Docs: https://docs.kalshi.com
import { getJson } from '../http.ts';
import type { Range } from './polymarket.ts';

export const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KsMarket {
  ticker: string;
  /** yes_sub_title: "193-197", "Below 193", "Above 4.25%". */
  label: string;
  /** What the strikes say, as a Range (see polymarket.ts). */
  range: Range | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  /** active, or closed / settled / finalized */
  status: string;
  volume: number;
}

export interface KsEvent {
  ticker: string;
  title: string;
  /** Its markets are buckets (exactly one wins) rather than separate thresholds. */
  exclusive: boolean;
  markets: KsMarket[];
}

const num = (x: unknown): number | null => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** strike_type with floor_strike / cap_strike, as a Range. */
export function kalshiRange(type: string, floor: number | null, cap: number | null): Range | null {
  switch (type) {
    case 'between':
      return floor !== null && cap !== null ? (floor === cap ? { kind: 'exact', a: floor } : { kind: 'range', a: floor, b: cap }) : null;
    case 'less':
      return cap !== null ? { kind: 'below', a: cap } : null;
    case 'less_or_equal':
      return cap !== null ? { kind: 'atMost', a: cap } : null;
    case 'greater':
      return floor !== null ? { kind: 'above', a: floor } : null;
    case 'greater_or_equal':
      return floor !== null ? { kind: 'atLeast', a: floor } : null;
    default:
      return null; // custom or structured strikes: not read
  }
}

export function parseKsEvent(json: unknown): KsEvent {
  const ev = (json as { event?: Record<string, unknown> }).event;
  if (!ev || !Array.isArray(ev.markets)) throw new Error('no such Kalshi event');
  return {
    ticker: String(ev.event_ticker ?? ''),
    title: String(ev.title ?? ''),
    exclusive: ev.mutually_exclusive === true,
    markets: (ev.markets as Record<string, unknown>[]).map((m) => {
      const bid = num(m.yes_bid_dollars);
      const ask = num(m.yes_ask_dollars);
      return {
        ticker: String(m.ticker ?? ''),
        label: String(m.yes_sub_title ?? ''),
        range: kalshiRange(String(m.strike_type ?? ''), num(m.floor_strike), num(m.cap_strike)),
        // Kalshi shows an empty side as 0 (bid) or 1 (ask)
        bid: bid !== null && bid > 0 ? bid : null,
        ask: ask !== null && ask < 1 ? ask : null,
        last: num(m.last_price_dollars),
        status: String(m.status ?? ''),
        volume: num(m.volume_fp) ?? num(m.volume) ?? 0,
      };
    }),
  };
}

export async function ksEvent(ticker: string): Promise<KsEvent> {
  return parseKsEvent(await getJson(`${KALSHI}/events/${encodeURIComponent(ticker)}?with_nested_markets=true`));
}

export const activeMarkets = (ev: KsEvent): KsMarket[] => ev.markets.filter((m) => m.status === 'active');
