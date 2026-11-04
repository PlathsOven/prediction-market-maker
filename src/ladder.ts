// Quoting: turn a view of the market's number into a two-sided ladder of limit orders, and a ladder into the
// cancels and placements that move the resting orders there.
//
// Sides, in a horizon book: an up (Higher) order is a bid, and a lower strike is a better bid; a down (Lower)
// order is an ask, and a higher strike is a better ask. A taker who sells into the bid at k holds Lower at k and
// wins if the number ends below k; one who buys from the ask at k holds Higher and wins if it ends above k.
// Every contract pays 2×, so a quote is fair when the taker wins half the time, and the maker's edge on a fill
// is twice the margin by which the taker's chance falls short of 50%.
import type { Dist } from './dist.ts';
import { type Grid, clean, indexOf, maxIndex, minIndex, strikeAt } from './grid.ts';
import type { Side } from './api.ts';

export interface Quote {
  side: Side;
  strike: number;
  /** Dollars. */
  size: number;
}

// ---- the quantile ladder: any distribution, any grid ---------------------------------------------------------

export interface LadderOptions {
  /** The best bid and ask leave a taker at most 50% − margin to win (0.04: the 46th and 54th percentiles). */
  margin: number;
  /** Levels a side. */
  levels: number;
  /** How much further out each level is, in probability: level i leaves the taker 50% − margin − i × step. */
  step: number;
  /** Dollars at each level (the last entry repeats). */
  sizes: readonly number[];
  /** A level whose taker would win less often than this is pointless (a Lower under a count that can only rise). */
  minTake: number;
}

export const LADDER: LadderOptions = { margin: 0.04, levels: 8, step: 0.04, sizes: [500], minTake: 0.002 };

const sizeAt = (o: LadderOptions, i: number): number => o.sizes[Math.min(i, o.sizes.length - 1)];

/**
 * The ladder for a distribution on a grid. Bids: the highest strike whose P(X < k) ≤ 50% − margin, then each
 * level the highest strike at least one step lower with P(X < k) ≤ 50% − margin − i × step. Asks mirror it with
 * P(X > k). A side whose best level would fall outside the market's strikes is left empty, so near a bound (a
 * deadline, 100% uptime) the book can be one-sided.
 */
export function quantileLadder(d: Dist, g: Grid, o: LadderOptions = LADDER): Quote[] {
  const [lo, hi] = d.support();
  // a strike index range wide enough to hold every quote: the support, one step either side, within bounds
  const nMin = Math.max(minIndex(g) ?? -Infinity, Math.floor(indexOf(g, lo)) - 1);
  const nMax = Math.min(maxIndex(g) ?? Infinity, Math.ceil(indexOf(g, hi)) + 1);
  if (nMin > nMax) return [];
  const quotes: Quote[] = [];

  let cap = nMax;
  for (let i = 0; i < o.levels; i++) {
    const q = 0.5 - o.margin - i * o.step;
    if (q < o.minTake) break;
    // the highest n ≤ cap with P(X < k_n) ≤ q (P(X < k) rises with k)
    const n = lastWhere(nMin, cap, (n) => d.below(strikeAt(g, n)) <= q + 1e-12);
    if (n === null || d.below(strikeAt(g, n)) < o.minTake) break;
    quotes.push({ side: 'up', strike: strikeAt(g, n), size: sizeAt(o, i) });
    cap = n - 1;
  }

  let floor = nMin;
  for (let i = 0; i < o.levels; i++) {
    const q = 0.5 - o.margin - i * o.step;
    if (q < o.minTake) break;
    // the lowest n ≥ floor with P(X > k_n) ≤ q (P(X > k) falls as k rises)
    const n = firstWhere(floor, nMax, (n) => d.above(strikeAt(g, n)) <= q + 1e-12);
    if (n === null || d.above(strikeAt(g, n)) < o.minTake) break;
    quotes.push({ side: 'down', strike: strikeAt(g, n), size: sizeAt(o, i) });
    floor = n + 1;
  }

  // a best bid at or over the best ask means an atom sits on a strike: quote neither rather than cross
  const bid = quotes.find((x) => x.side === 'up');
  const ask = quotes.find((x) => x.side === 'down');
  if (bid && ask && bid.strike >= ask.strike) return [];
  return quotes;
}

/** The largest n in [a, b] where pred holds, for a pred that holds up to some point and fails after. */
function lastWhere(a: number, b: number, pred: (n: number) => boolean): number | null {
  if (a > b || !pred(a)) return null;
  while (a < b) {
    const mid = Math.floor((a + b + 1) / 2);
    if (pred(mid)) a = mid;
    else b = mid - 1;
  }
  return a;
}

/** The smallest n in [a, b] where pred holds, for a pred that fails up to some point and holds after. */
function firstWhere(a: number, b: number, pred: (n: number) => boolean): number | null {
  if (a > b || !pred(b)) return null;
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    if (pred(mid)) b = mid;
    else a = mid + 1;
  }
  return a;
}

// ---- the feed ladder: a price feed and its volatility (BTC, Gold) -------------------------------------------

/**
 * How a feed market is quoted, calibrated on Bitcoin: the best bid and ask are `width` strikes apart at
 * `horizon` seconds in a calm market (volatility at or under `vol` a year), wider as √horizon and, up to 3×,
 * as realised volatility runs above `vol`.
 */
export interface FeedCalibration {
  vol: number;
  width: number;
  horizon: number;
  levels: number;
  size: number;
}

/** BTC: 1 strike ($1) at 15 s, so 2 at 1 m and 4 at 5 m, calm at 45% a year; ten levels of $1,000 a side. */
export const BTC_FEED: FeedCalibration = { vol: 0.45, width: 1, horizon: 15, levels: 10, size: 1_000 };

const YEAR_S = 365 * 24 * 3600;
/** A volatility a year, per root second. */
export const perRootSecond = (annual: number): number => annual / Math.sqrt(YEAR_S);
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Best ask minus best bid, in strikes (BTC: 1 / 2 / 4 at 15 s / 1 m / 5 m, up to 3× while volatility runs high). */
export function quoteWidth(horizon: number, sigmaS: number, cal: FeedCalibration = BTC_FEED): number {
  const m = clamp(sigmaS / perRootSecond(cal.vol), 1, 3);
  return Math.max(cal.width, Math.round(cal.width * Math.sqrt(horizon / cal.horizon) * m));
}

/**
 * One feed book's quotes around spot. sigma is the market's one-sigma move over the horizon (GET /markets; 0
 * while it has too few ticks). The number at expiry is about normal around spot with that sigma: the best bid
 * and ask sit quoteWidth strikes apart, centred on spot (on BTC near $80,000 at calm volatility about ±0.02σ, so
 * a taker wins about 49.2%), and the other levels sit on a fixed grid of multiples of 6% of sigma beyond them,
 * all one size, so a small move changes only the best levels and an end of the ladder.
 */
export function feedLadder(spot: number, sigma: number, horizon: number, g: Grid, cal: FeedCalibration = BTC_FEED): Quote[] {
  const seed = perRootSecond(cal.vol);
  const sigmaS = sigma > 0 ? sigma / (spot * Math.sqrt(horizon)) : seed;
  const sigmaUnits = sigma > 0 ? sigma : spot * seed * Math.sqrt(horizon);
  const width = quoteWidth(horizon, sigmaS, cal);
  const bestBid = Math.round(indexOf(g, spot) - width / 2);
  return feedQuotes(g, bestBid, bestBid + width, Math.max(1, Math.round((0.06 * sigmaUnits) / g.step)), cal.levels, cal.size);
}

/**
 * A feed book from its best bid and ask (strike indices) out: the other levels on multiples of `spacing` strikes
 * beyond them, `levels` a side in all, one size, within the market's strikes.
 */
function feedQuotes(g: Grid, bestBid: number, bestAsk: number, spacing: number, levels: number, size: number): Quote[] {
  const lo = minIndex(g);
  const hi = maxIndex(g);
  const ok = (n: number) => strikeAt(g, n) > 0 && (lo === null || n >= lo) && (hi === null || n <= hi);
  const quotes: Quote[] = [];
  if (ok(bestBid)) quotes.push({ side: 'up', strike: strikeAt(g, bestBid), size });
  if (ok(bestAsk)) quotes.push({ side: 'down', strike: strikeAt(g, bestAsk), size });
  const below = Math.floor((bestBid - 1) / spacing);
  const above = Math.ceil((bestAsk + 1) / spacing);
  for (let i = 0; i < levels - 1; i++) {
    const bid = (below - i) * spacing;
    if (ok(bid)) quotes.push({ side: 'up', strike: strikeAt(g, bid), size });
    const ask = (above + i) * spacing;
    if (ok(ask)) quotes.push({ side: 'down', strike: strikeAt(g, ask), size });
  }
  return quotes;
}

// ---- the sigma ladder: BTC's, written in sigmas (Gold) ---------------------------------------------------------

/**
 * A feed ladder measured in sigma, for a market whose strikes are coarse next to its moves (gold: $0.10 strikes
 * against a 15-second sigma of about $0.55), where a width in strikes wouldn't mean much: the best
 * bid is the highest strike at least touch × sigma under spot, the best ask the lowest at least as far over it, and
 * the other levels sit on a fixed grid of multiples of spacing × sigma (at least a strike) beyond them.
 */
export interface SigmaCalibration {
  /** The calmest volatility (a year) it assumes: sigma is never taken under this, so a quiet spell can't close the touch. */
  minVol: number;
  /** Distance from spot to each side's best quote, in sigmas. */
  touch: number;
  /** Distance between the outer levels, in sigmas. */
  spacing: number;
  levels: number;
  size: number;
}

/** Gold: a touch at ±0.04σ, levels 0.06σ apart; sigma no lower than 12% a year. */
export const GOLD_SIGMA: SigmaCalibration = { minVol: 0.12, touch: 0.04, spacing: 0.06, levels: 10, size: 1_000 };

/** One sigma-ladder book around spot (sigma: the market's one-sigma move over the horizon, 0 while unknown). */
export function sigmaLadder(spot: number, sigma: number, horizon: number, g: Grid, cal: SigmaCalibration = GOLD_SIGMA): Quote[] {
  const s = Math.max(sigma > 0 ? sigma : 0, spot * perRootSecond(cal.minVol) * Math.sqrt(horizon));
  // the highest strike at or under spot − touch σ, and the lowest at or over spot + touch σ
  const bestBid = Math.floor(indexOf(g, spot - cal.touch * s) + 1e-9);
  const bestAsk = Math.ceil(indexOf(g, spot + cal.touch * s) - 1e-9);
  return feedQuotes(g, bestBid, bestAsk, Math.max(1, Math.round((cal.spacing * s) / g.step)), cal.levels, cal.size);
}

// ---- re-quoting -----------------------------------------------------------------------------------------------

export interface Resting {
  id: string;
  market: string;
  side: Side;
  strike: number;
  /** size − filled */
  remaining: number;
}

/**
 * A feed book's target, made sticky. A price move makes one side less safe (the one it moved toward) and the other
 * more (the one it moved away from); re-quoting both on every strike's move would spend the exchange's order
 * budget on wiggles. So a side keeps its resting quotes while its best is at most `slack` strikes further from spot
 * than the target's best, and at most `tolerance` strikes nearer (less than the edge can absorb). Otherwise it
 * takes the target's. Only a complete resting side (as many levels as the target) stands in.
 */
export function sticky(target: readonly Quote[], resting: readonly Resting[], step: number, slack: number, tolerance: number): Quote[] {
  const out: Quote[] = [];
  for (const side of ['up', 'down'] as const) {
    const t = target.filter((q) => q.side === side);
    const r = resting.filter((o) => o.side === side);
    if (!t.length || r.length !== t.length) {
      out.push(...t);
      continue;
    }
    const best = (ks: number[]) => (side === 'up' ? Math.max(...ks) : Math.min(...ks));
    const tBest = best(t.map((q) => q.strike));
    const rBest = best(r.map((o) => o.strike));
    // how many strikes further from spot the resting best is (a lower bid, a higher ask); negative: nearer
    const away = Math.round((side === 'up' ? tBest - rBest : rBest - tBest) / step);
    if (away <= slack && away >= -tolerance) out.push(...r.map((o) => ({ side, strike: o.strike, size: t[0].size })));
    else out.push(...t);
  }
  return out;
}

/** How sticky a feed book is, from its sigma in strikes: the away side lags up to 0.04σ (at least a strike), the near side 0.02σ. */
export const stickiness = (sigma: number, step: number): { slack: number; tolerance: number } => ({
  slack: Math.max(1, Math.round((0.04 * sigma) / step)),
  tolerance: Math.floor((0.02 * sigma) / step),
});

/**
 * What to cancel and place to turn resting into target. A resting order is kept while a target quote has its
 * side and strike and it still has half the size; everything else is canceled. New quotes come nearest the
 * centre (spot, or the median) first, so when the order budget runs short the best levels go out first.
 */
export function plan(target: readonly Quote[], resting: readonly Resting[], center: number): { cancel: string[]; place: Quote[] } {
  const key = (side: Side, strike: number) => `${side}:${clean(strike)}`;
  const want = new Map(target.map((q) => [key(q.side, q.strike), q]));
  const kept = new Set<string>();
  const cancel: string[] = [];
  for (const o of resting) {
    const k = key(o.side, o.strike);
    const q = want.get(k);
    if (q && !kept.has(k) && o.remaining >= q.size / 2) kept.add(k);
    else cancel.push(o.id);
  }
  const place = target
    .filter((q) => !kept.has(key(q.side, q.strike)))
    .sort((a, b) => Math.abs(a.strike - center) - Math.abs(b.strike - center));
  return { cancel, place };
}
