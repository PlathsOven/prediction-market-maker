// From another venue's prices to a distribution of the number.
//
// Two shapes of market come in:
//   buckets   mutually exclusive ranges, exactly one wins ("195-199 seats" 14¢, "200-204" 13.6¢, …)
//   points    a ladder of separate yes/no markets, each a point on the CDF ("IPO by Nov 20?" 61¢, "FDV above
//             $1.5B?" 32¢: P(X ≤ Nov 20) = 0.61, P(X > 1.5) = 0.32)
//
// Bucket prices are fitted inside their spreads: each bucket gets bid + λ × (ask − bid), with one λ for the
// event chosen so the buckets sum to 1. With tight books that is the normalised mid; with wide ones (a 2¢ bid
// and a 25¢ ask) it leans on the side the rest of the book supports, where a mid would overstate the bucket.
// Ladder points use the mid while the spread is reasonable, the last trade while it's a little wider (if it traded
// inside the quotes), and are dropped beyond that (the neighbours carry the curve); then a weighted monotone fit,
// so a pair of crossing quotes can't make the CDF fall.
import { Dist, isotonic, type Segment } from './dist.ts';
import type { Range } from './sources/polymarket.ts';

/** What kind of number a market is on. */
export type ValueType =
  /** whole numbers (seats, posts): v occupies [v − 0.5, v + 0.5) */
  | { type: 'integer' }
  /** any real number (margins, market caps, yields, uptime) */
  | { type: 'continuous' }
  /** discrete levels on multiples of step (the Fed's target rate, in 0.25 steps) */
  | { type: 'levels'; step: number };

export interface Quoted {
  label: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
}

export interface Bucket extends Quoted {
  range: Range;
}

/** A bucket's [lo, hi) on the number line, null for an open end (levels: the inclusive range of levels). */
export function interval(r: Range, v: ValueType): [number | null, number | null] {
  const a = r.a;
  const b = r.kind === 'range' ? r.b : r.a;
  if (v.type === 'integer') {
    switch (r.kind) {
      case 'range':
      case 'exact':
        return [a - 0.5, b + 0.5];
      case 'below':
        return [null, a - 0.5];
      case 'atMost':
        return [null, a + 0.5];
      case 'atLeast':
        return [a - 0.5, null];
      case 'above':
        return [a + 0.5, null];
    }
  }
  if (v.type === 'levels') {
    const s = v.step;
    switch (r.kind) {
      case 'range':
      case 'exact':
        return [a, b];
      case 'below':
        return [null, a - s];
      case 'atMost':
        return [null, a];
      case 'atLeast':
        return [a, null];
      case 'above':
        return [a + s, null];
    }
  }
  switch (r.kind) {
    case 'range':
      return [a, b];
    case 'exact':
      return [a, a];
    case 'below':
    case 'atMost':
      return [null, a];
    case 'atLeast':
    case 'above':
      return [a, null];
  }
}

/** A quote's range: no bid means it could be as low as 0, no ask (nobody sells) as high as 1. */
const sideOf = (q: Quoted) => {
  const bid = q.bid ?? 0;
  const ask = q.ask ?? 1;
  return { bid: Math.min(bid, ask), ask: Math.max(bid, ask) };
};

/** Each bucket's probability, fitted inside its bid-ask spread so they sum to 1 (else normalised mids). */
export function fitBuckets<B extends Bucket>(bs: readonly B[]): (B & { p: number; spread: number })[] {
  const sides = bs.map(sideOf);
  const lo = sides.reduce((t, s) => t + s.bid, 0);
  const hi = sides.reduce((t, s) => t + s.ask, 0);
  if (lo <= 1 && hi >= 1 && hi > lo) {
    const lambda = (1 - lo) / (hi - lo);
    return bs.map((b, i) => ({ ...b, p: sides[i].bid + lambda * (sides[i].ask - sides[i].bid), spread: sides[i].ask - sides[i].bid }));
  }
  // the book is crossed or stale (bids alone add up past 1): normalised mids
  const mids = sides.map((s) => (s.bid + s.ask) / 2);
  const total = mids.reduce((t, x) => t + x, 0);
  if (!(total > 0)) throw new Error('no prices');
  return bs.map((b, i) => ({ ...b, p: mids[i] / total, spread: sides[i].ask - sides[i].bid }));
}

/** The probability-weighted spread of fitted buckets: how wide the book is where the mass is. */
export const bucketSpread = (bs: readonly { p: number; spread: number }[]): number =>
  bs.reduce((t, b) => t + b.p * b.spread, 0) / Math.max(1e-12, bs.reduce((t, b) => t + b.p, 0));

/**
 * Fitted buckets as a distribution: each bucket's probability spread evenly over its range, open ends cut at
 * the support (written in the market's config: where the tails plausibly end). On a levels market each bucket
 * is one level, or its levels in equal shares.
 */
export function bucketDist(bs: readonly { range: Range; p: number }[], v: ValueType, support: readonly [number, number]): Dist {
  const [smin, smax] = support;
  const atoms: [number, number][] = [];
  const segments: Segment[] = [];
  for (const b of bs) {
    if (!(b.p > 0)) continue;
    const [l, h] = interval(b.range, v);
    if (v.type === 'levels') {
      const s = v.step;
      const from = Math.ceil(((l ?? smin) - 1e-9) / s);
      const to = Math.floor(((h ?? smax) + 1e-9) / s);
      const levels: number[] = [];
      for (let n = from; n <= to; n++) if (n * s >= smin - 1e-9 && n * s <= smax + 1e-9) levels.push(Math.round(n * s * 1e9) / 1e9);
      if (!levels.length) levels.push(Math.min(smax, Math.max(smin, l ?? h ?? smin)));
      for (const x of levels) atoms.push([x, b.p / levels.length]);
      continue;
    }
    let lo = Math.max(l ?? smin, smin);
    let hi = Math.min(h ?? smax, smax);
    if (hi <= lo) {
      // the whole bucket is outside the support (or a single value): an atom where it touches it
      if (l !== null && h !== null && l === h) atoms.push([Math.min(smax, Math.max(smin, l)), b.p]);
      else atoms.push([hi <= smin ? smin : smax, b.p]);
      continue;
    }
    segments.push({ lo, hi, p: b.p });
  }
  return new Dist(atoms, segments);
}

// ---- ladders of points --------------------------------------------------------------------------------------

export interface LadderPoint extends Quoted {
  /** Where on the number line the point reads the CDF. */
  x: number;
  /** The market pays if the number ends above x (survival), rather than at or below it (cumulative). */
  survival: boolean;
}

export interface FittedPoint extends LadderPoint {
  /** P(X ≤ x), after the monotone fit. */
  F: number;
  spread: number;
}

/**
 * The CDF read off a ladder, as P(X ≤ x): each point's mid while its spread is at most maxSpread; up to twice that,
 * its last trade if that's inside the quotes; wider ones are dropped. Then it's made non-decreasing in x (pool
 * adjacent violators, tighter quotes weighing more).
 */
export function fitPoints(ps: readonly LadderPoint[], maxSpread = 0.1): FittedPoint[] {
  const kept = ps
    .flatMap((p) => {
      if (p.bid === null && p.ask === null) return [];
      const s = sideOf(p);
      const spread = s.ask - s.bid;
      const lastInside = p.last !== null && p.last >= s.bid && p.last <= s.ask;
      const mid = spread <= maxSpread ? (s.bid + s.ask) / 2 : spread <= 2 * maxSpread && lastInside ? p.last! : null;
      return mid === null ? [] : [{ ...p, spread, mid }];
    })
    .sort((a, b) => a.x - b.x);
  const raw = kept.map((p) => (p.survival ? 1 - p.mid : p.mid));
  const fitted = isotonic(raw, kept.map((p) => 1 / (p.spread + 0.01)));
  return kept.map(({ mid: _mid, ...p }, i) => ({ ...p, F: Math.min(1, Math.max(0, fitted[i])) }));
}

/** The spread of the ladder where it crosses the middle: the points with F in [0.2, 0.8], or the two around 0.5. */
export function pointSpread(ps: readonly FittedPoint[]): number {
  const mid = ps.filter((p) => p.F >= 0.2 && p.F <= 0.8);
  const near = mid.length ? mid : [...ps].sort((a, b) => Math.abs(a.F - 0.5) - Math.abs(b.F - 0.5)).slice(0, 2);
  return near.reduce((t, p) => t + p.spread, 0) / Math.max(1, near.length);
}

/**
 * A ladder's CDF as a distribution: linear between its points, from F = 0 at the support's low end to F = 1 at
 * its high end (points outside the support are ignored). On a levels market each level gets the CDF's rise
 * since the level below.
 */
export function pointDist(ps: readonly { x: number; F: number }[], v: ValueType, support: readonly [number, number]): Dist {
  const [smin, smax] = support;
  // on levels, F = 0 just below the lowest level, so the lowest level itself can carry probability
  const start = v.type === 'levels' ? smin - v.step : smin;
  const inside = ps.filter((p) => p.x > start && p.x < smax).sort((a, b) => a.x - b.x);
  const knots: [number, number][] = [[start, 0], ...inside.map((p): [number, number] => [p.x, p.F]), [smax, 1]];
  if (v.type !== 'levels') return Dist.fromCdf(knots);
  const at = (x: number) => {
    if (x <= knots[0][0]) return 0;
    for (let i = 1; i < knots.length; i++) {
      const [x1, f1] = knots[i];
      const [x0, f0] = knots[i - 1];
      if (x <= x1) return f0 + ((f1 - f0) * (x - x0)) / (x1 - x0);
    }
    return 1;
  };
  const atoms: [number, number][] = [];
  const s = v.step;
  for (let n = Math.ceil(smin / s - 1e-9); n * s <= smax + 1e-9; n++) {
    const x = Math.round(n * s * 1e9) / 1e9;
    atoms.push([x, Math.max(0, at(x) - at(x - s))]);
  }
  return new Dist(atoms, []);
}

/** Where a threshold market reads the CDF, for a number of this type: the threshold, shifted to a half unit on whole numbers. */
export function thresholdX(r: Range, v: ValueType): { x: number; survival: boolean } | null {
  const half = v.type === 'integer' ? 0.5 : 0;
  const step = v.type === 'levels' ? v.step : 0;
  switch (r.kind) {
    case 'above':
      return { x: r.a + half, survival: true };
    case 'atLeast':
      return { x: r.a - half - step, survival: true };
    case 'atMost':
      return { x: r.a + half, survival: false };
    case 'below':
      return { x: r.a - half - step, survival: false };
    default:
      return null;
  }
}
