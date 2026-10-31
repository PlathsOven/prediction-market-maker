// The markets the read and audit commands look at: the exchange's own listing of each underlying the bots have a
// model for, else the market table's (src/markets.ts `offline`), with Elon's count read from XTracker.
import type { Market } from './api.ts';
import { CATALOG, offlineListings } from './markets.ts';
import { getJson } from './http.ts';
import { XTRACKER } from './sources/xtracker.ts';

const BLANK: Market = { id: '', underlying: '', horizon: null, strikeStep: 1, strikeOffset: 0, spot: null, live: true, bid: null, ask: null, bidSize: 0, askSize: 0, sigma: 0, status: 'open' };

/**
 * ELON-POSTS as the exchange defines it (its market rules): XTracker's running total of Elon Musk's posts less
 * 2,618, its total at the start of 2026. Only for reading before the exchange lists it: quoting uses Rizon's own.
 */
export async function elonCount(): Promise<number | null> {
  const user = await getJson<{ data?: { _count?: { posts?: number } } }>(`${XTRACKER}/users/elonmusk`, 60_000).catch(() => null);
  const total = user?.data?._count?.posts;
  return typeof total === 'number' ? total - 2_618 : null;
}

/** Every market to look at, each with whether the exchange lists it; feeds too when `feeds` is set. */
export async function marketsToRead(listed: readonly Market[], feeds = false): Promise<{ market: Market; fromExchange: boolean }[]> {
  const out: { market: Market; fromExchange: boolean }[] = [];
  for (const [underlying, entry] of Object.entries(CATALOG)) {
    const kind = entry.spec.model;
    if (!feeds && (kind === 'feed' || kind === 'sigmaFeed')) continue;
    const fromExchange = listed.filter((m) => m.underlying === underlying);
    if (fromExchange.length) {
      for (const m of fromExchange) out.push({ market: m, fromExchange: true });
      continue;
    }
    const spot = kind === 'elon' ? await elonCount() : null;
    for (const l of offlineListings(entry)) out.push({ market: { ...BLANK, ...l, underlying, spot }, fromExchange: false });
  }
  return out;
}
