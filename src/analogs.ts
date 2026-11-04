// Reading an analog market (a Polymarket or Kalshi event on the same question) as a distribution of our number.
// The view functions are pure, over events already fetched, so they're tested on recorded responses;
// readAnalogAndTape() fetches and views in one step.
import { type Bucket, type FittedPoint, type LadderPoint, type Quoted, type ValueType, bucketDist, bucketSpread, fitBuckets, fitPoints, interval, pointDist, pointSpread, thresholdX } from './buckets.ts';
import type { Dist } from './dist.ts';
import { type KsEvent, type KsMarket, activeMarkets, ksEvent } from './sources/kalshi.ts';
import { type LabelOptions, type PmEvent, type Range, atLastTrades, parseLabel, pmEvent, tradingMarkets } from './sources/polymarket.ts';
import { Unreadable } from './models/model.ts';

/** A bucket's values, as written in config: [lo, hi] (whole numbers and levels inclusive; continuous [lo, hi)), null for an open end. */
export type Edges = readonly [number | null, number | null];

export interface PolymarketBuckets {
  venue: 'polymarket';
  slug: string;
  shape?: 'buckets';
  weight?: number;
  /** Each bucket's values by label. A label missing here is parsed from its text instead. */
  edges?: Readonly<Record<string, Edges>>;
  /** Split one bucket by another event's finer buckets inside it (Polymarket's "lower brackets" events). */
  refine?: { slug: string; bucket: string; edges?: Readonly<Record<string, Edges>> };
  labels?: LabelOptions;
}

export interface PolymarketLadder {
  venue: 'polymarket';
  slug: string;
  /** survival: each market pays if the number ends above its threshold ("FDV above $1.5B?", "hit 5.4%?"). */
  shape: 'survival' | 'cumulative';
  weight?: number;
  labels?: LabelOptions;
}

export interface KalshiSpec {
  venue: 'kalshi';
  event: string;
  weight?: number;
  /** The event counts the other side: our number is mirror − theirs (Democratic seats → Republican: 435 − D). */
  mirror?: number;
  /**
   * A spread: each market is one team winning by over x (a ticker ending -DET4 is Detroit by over 3.5), and our number
   * is this team's margin.
   */
  home?: string;
}

export type AnalogSpec = PolymarketBuckets | PolymarketLadder | KalshiSpec;

const isLadder = (s: PolymarketBuckets | PolymarketLadder): s is PolymarketLadder => s.shape === 'survival' || s.shape === 'cumulative';

export interface AnalogOptions {
  value: ValueType;
  /** Where open-ended buckets and the CDF's ends stop. */
  support: readonly [number, number];
  /** Labels whose bucket voids the market (dropped before fitting, so the rest is conditional on the event). */
  drop?: readonly RegExp[];
  /** Read a survival ladder as conditional on the event happening: divide by the lowest threshold's price. */
  conditional?: boolean;
}

export interface View {
  name: string;
  dist: Dist;
  /** Probability-weighted spread where the mass is. */
  spread: number;
  rows: { label: string; bid: number | null; ask: number | null; p: number }[];
}

/** A view of buckets fitted inside their spreads: the spread where the mass is, and a row a bucket. */
export const bucketView = (name: string, dist: Dist, fitted: readonly (Quoted & { p: number; spread: number })[]): View => ({
  name,
  dist,
  spread: bucketSpread(fitted),
  rows: fitted.map((b) => ({ label: b.label, bid: b.bid, ask: b.ask, p: b.p })),
});

/** A view of a fitted ladder: the spread where it crosses the middle, and a row a point, at P(X ≤ x). */
export const pointView = (name: string, dist: Dist, fitted: readonly FittedPoint[]): View => ({
  name,
  dist,
  spread: pointSpread(fitted),
  rows: fitted.map((p) => ({ label: p.label, bid: p.bid, ask: p.ask, p: p.F })),
});

export const rangeOfEdges = ([lo, hi]: Edges): Range | null =>
  lo !== null && hi !== null
    ? lo === hi
      ? { kind: 'exact', a: lo }
      : { kind: 'range', a: lo, b: hi }
    : lo !== null
      ? { kind: 'atLeast', a: lo }
      : hi !== null
        ? { kind: 'atMost', a: hi }
        : null;

/** An event's trading buckets, each with its range; throws Unreadable if any label can't be placed. */
function pmBuckets(ev: PmEvent, edges: Readonly<Record<string, Edges>> | undefined, labels: LabelOptions | undefined, drop: readonly RegExp[] = []): Bucket[] {
  return tradingMarkets(ev)
    .filter((m) => !drop.some((re) => re.test(m.label)))
    .map((m) => {
      const range = edges?.[m.label] ? rangeOfEdges(edges[m.label]) : parseLabel(m.label, labels);
      if (!range) throw new Unreadable(`can't read the bucket "${m.label}" in ${ev.slug}`);
      return { label: m.label, bid: m.bid, ask: m.ask, last: m.last, range };
    });
}

const contains = (outer: [number | null, number | null], inner: [number | null, number | null]) =>
  (outer[0] === null || (inner[0] !== null && inner[0] >= outer[0] - 1e-9)) && (outer[1] === null || (inner[1] !== null && inner[1] <= outer[1] + 1e-9));

/** A Polymarket bucket event as a distribution, with one bucket optionally split by a finer event. */
export function viewPmBuckets(ev: PmEvent, spec: PolymarketBuckets, o: AnalogOptions, refineEv?: PmEvent): View {
  const fitted = fitBuckets(pmBuckets(ev, spec.edges, spec.labels, o.drop));
  if (!fitted.length) throw new Unreadable(`no trading buckets in ${ev.slug}`);
  let parts: { range: Range; p: number }[] = fitted;
  if (spec.refine && refineEv) {
    const target = fitted.find((b) => b.label === spec.refine!.bucket);
    if (target) {
      const outer = interval(target.range, o.value);
      const fine = fitBuckets(pmBuckets(refineEv, spec.refine.edges, spec.labels)).filter((b) => contains(outer, interval(b.range, o.value)));
      const share = fine.reduce((t, b) => t + b.p, 0);
      // only when the finer buckets tile the coarse one, end to end
      const ends = fine.map((b) => interval(b.range, o.value));
      const lo = ends.some((e) => e[0] === null) ? null : Math.min(...ends.map((e) => e[0]!));
      const hi = ends.some((e) => e[1] === null) ? null : Math.max(...ends.map((e) => e[1]!));
      if (share > 0 && lo === outer[0] && hi === outer[1]) {
        parts = [...fitted.filter((b) => b !== target), ...fine.map((b) => ({ range: b.range, p: (target.p * b.p) / share }))];
      }
    }
  }
  return bucketView(`Polymarket ${ev.slug}`, bucketDist(parts, o.value, o.support), fitted);
}

/** A Polymarket ladder of thresholds as a distribution. */
export function viewPmLadder(ev: PmEvent, spec: PolymarketLadder, o: AnalogOptions): View {
  const points: LadderPoint[] = tradingMarkets(ev).map((m) => {
    const r = parseLabel(m.label, spec.labels);
    if (!r || r.kind !== 'exact') throw new Unreadable(`can't read the threshold "${m.label}" in ${ev.slug}`);
    // "above x" (survival) or "x or under" (cumulative); on a continuous number the two ends of x are the same
    const t = thresholdX({ kind: spec.shape === 'survival' ? 'above' : 'atMost', a: r.a }, o.value)!;
    return { label: m.label, bid: m.bid, ask: m.ask, last: m.last, ...t };
  });
  let fitted = fitPoints(points);
  if (fitted.length < 2) throw new Unreadable(`too few readable thresholds in ${ev.slug}`);
  if (o.conditional) {
    // P(X > x | the event) = P(X > x) / P(the event), the event's chance read off the lowest threshold
    const f0 = fitted[0].F;
    fitted = fitted.map((p) => ({ ...p, F: f0 < 1 ? (p.F - f0) / (1 - f0) : p.F }));
  }
  return pointView(`Polymarket ${ev.slug}`, pointDist(fitted, o.value, o.support), fitted);
}

/** Kalshi's ranges for our number: mirrored (mirror − x) when the event counts the other side. */
function mirrorRange(r: Range, m: number): Range {
  switch (r.kind) {
    case 'range':
      return { kind: 'range', a: m - r.b, b: m - r.a };
    case 'exact':
      return { kind: 'exact', a: m - r.a };
    case 'below':
      return { kind: 'above', a: m - r.a };
    case 'atMost':
      return { kind: 'atLeast', a: m - r.a };
    case 'atLeast':
      return { kind: 'atMost', a: m - r.a };
    case 'above':
      return { kind: 'below', a: m - r.a };
  }
}

/** A spread's market as the home team's margin: the home team by over x is above +x; the away team by over x is below −x. */
function marginRange(m: KsMarket, home: string): Range | null {
  const team = /-([A-Z]+)\d+$/.exec(m.ticker)?.[1];
  if (m.range?.kind !== 'above' || !team) return null;
  return team === home ? m.range : { kind: 'below', a: -m.range.a };
}

/** A Kalshi event as a distribution: buckets when exactly one market wins, else a ladder of thresholds. */
export function viewKalshi(ev: KsEvent, spec: KalshiSpec, o: AnalogOptions): View {
  const ms = activeMarkets(ev).filter((m) => m.range);
  const ranged = ms.flatMap((m) => {
    const range = spec.home ? marginRange(m, spec.home) : spec.mirror === undefined ? m.range! : mirrorRange(m.range!, spec.mirror);
    return range ? [{ ...m, range }] : [];
  });
  const name = `Kalshi ${ev.ticker}${spec.mirror !== undefined ? ` (${spec.mirror} − x)` : ''}`;
  if (ev.exclusive) {
    const fitted = fitBuckets(ranged.map((m) => ({ label: m.label, bid: m.bid, ask: m.ask, last: m.last, range: m.range })));
    if (!fitted.length) throw new Unreadable(`no active markets in ${ev.ticker}`);
    return bucketView(name, bucketDist(fitted, o.value, o.support), fitted);
  }
  const points: LadderPoint[] = ranged.flatMap((m) => {
    const t = thresholdX(m.range, o.value);
    return t ? [{ label: m.label, bid: m.bid, ask: m.ask, last: m.last, ...t }] : [];
  });
  const fitted = fitPoints(points);
  if (fitted.length < 2) throw new Unreadable(`too few quoted thresholds in ${ev.ticker} (spreads over 10¢)`);
  return pointView(name, pointDist(fitted, o.value, o.support), fitted);
}

/** A Kalshi event at its last trades (bid and ask both), the markets that never traded left out: a check on the quotes. */
export const ksAtLastTrades = (ev: KsEvent): KsEvent => ({
  ...ev,
  markets: ev.markets.flatMap((m) => (m.last === null || m.last <= 0 ? [] : [{ ...m, bid: m.last, ask: m.last }])),
});

/** Fetches one analog and views it at its quotes, and (when it reads) at its last trades: the same request, two views. */
export async function readAnalogAndTape(spec: AnalogSpec, o: AnalogOptions): Promise<{ view: View; tape: View | null }> {
  const attempt = (f: () => View): View | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  if (spec.venue === 'kalshi') {
    const ev = await ksEvent(spec.event);
    return { view: viewKalshi(ev, spec, o), tape: attempt(() => viewKalshi(ksAtLastTrades(ev), spec, o)) };
  }
  const ev = await pmEvent(spec.slug);
  if (isLadder(spec)) return { view: viewPmLadder(ev, spec, o), tape: attempt(() => viewPmLadder(atLastTrades(ev), spec, o)) };
  const refine = spec.refine ? await pmEvent(spec.refine.slug).catch(() => undefined) : undefined;
  return {
    view: viewPmBuckets(ev, spec, o, refine),
    tape: attempt(() => viewPmBuckets(atLastTrades(ev), spec, o, refine && atLastTrades(refine))),
  };
}

export const analogName = (s: AnalogSpec): string => (s.venue === 'kalshi' ? `Kalshi ${s.event}${s.mirror !== undefined ? ` (${s.mirror} − x)` : ''}` : `Polymarket ${s.slug}`);
