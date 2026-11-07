// Reading an analog market (a Polymarket or Kalshi event on the same question) as a distribution of our number.
// The view functions are pure, over events already fetched, so they're tested on recorded responses;
// readAnalogAndTape() fetches and views in one step.
import { type Bucket, type FittedPoint, type LadderPoint, type Quoted, type ValueType, bucketDist, bucketSpread, fitBuckets, fitPoints, interval, pointDist, pointSpread, thresholdX } from './buckets.ts';
import { Dist, normalKnots, normInv } from './dist.ts';
import { type KsEvent, type KsMarket, activeMarkets, ksEvent } from './sources/kalshi.ts';
import { type LabelOptions, type PmEvent, type PmMarket, type Range, atLastTrades, parseLabel, pmEvent, tradingMarkets } from './sources/polymarket.ts';
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

/**
 * A game's event (nfl-chi-det-2026-11-26): its over/under ladder for the total, or for the home team's margin, both
 * teams' spread ladders and the moneyline, one curve through all three.
 */
export interface PolymarketGame {
  venue: 'polymarket';
  slug: string;
  shape: 'total' | 'margin';
  /** The home team as the event's outcomes name it ("Lions"): the margin is theirs. */
  home?: string;
  /**
   * The number's usual standard deviation. Days before a game, the event may quote only a line or two (the moneyline
   * first): too few to reach the middle from both sides, so the view is a normal this wide through them, quoted as
   * thin. Without it, such a ladder doesn't read.
   */
  sigma?: number;
  weight?: number;
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

export type AnalogSpec = PolymarketBuckets | PolymarketLadder | PolymarketGame | KalshiSpec;

type PolymarketSpec = Exclude<AnalogSpec, KalshiSpec>;
const isLadder = (s: PolymarketSpec): s is PolymarketLadder => s.shape === 'survival' || s.shape === 'cumulative';
const isGame = (s: PolymarketSpec): s is PolymarketGame => s.shape === 'total' || s.shape === 'margin';

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
  /** Its shape is partly assumed (a normal through a price or two): quoted as a thin source, whatever its spread. */
  thin?: boolean;
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

/**
 * A game's market as a threshold on our number, or null when it's about something else (a quarter, a team's own
 * total). The first outcome is the one priced: "Over" 50.5 is the total above 50.5; a team at −6.5 wins by over 6.5,
 * the home team's margin above 6.5 or the away team's below −6.5. The moneyline is a team winning at all, over 0 (a
 * tie, resolved 50-50 and about 0.3% of games, is left out).
 */
function gameRange(m: PmMarket, spec: PolymarketGame): Range | null {
  const [first] = m.outcomes;
  if (spec.shape === 'total') {
    if (m.type !== 'totals' || m.line === null) return null;
    return first === 'Over' ? { kind: 'above', a: m.line } : first === 'Under' ? { kind: 'below', a: m.line } : null;
  }
  const by = m.type === 'moneyline' ? 0 : m.type === 'spreads' && m.line !== null ? -m.line : null;
  if (by === null || !spec.home || m.outcomes.length !== 2 || !m.outcomes.includes(spec.home)) return null;
  return first === spec.home ? { kind: 'above', a: by } : { kind: 'below', a: -by };
}

/** A Polymarket game's ladder for the total or the home team's margin, as a distribution. */
export function viewPmGame(ev: PmEvent, spec: PolymarketGame, o: AnalogOptions): View {
  // a misspelled team would otherwise read as "no spreads yet" for good
  if (spec.shape === 'margin' && !ev.markets.some((m) => spec.home && m.outcomes.includes(spec.home))) throw new Unreadable(`no market in ${ev.slug} names the ${spec.home}`);
  const points: LadderPoint[] = tradingMarkets(ev).flatMap((m) => {
    const r = gameRange(m, spec);
    const t = r && thresholdX(r, o.value);
    return t ? [{ label: m.question || m.label, bid: m.bid, ask: m.ask, last: m.last, ...t }] : [];
  });
  const fitted = fitPoints(points);
  const name = `Polymarket ${ev.slug} (${spec.shape})`;
  // a ladder that reaches the middle from both sides: the curve through it
  if (fitted.some((p) => p.F <= 0.5) && fitted.some((p) => p.F >= 0.5)) return pointView(name, pointDist(fitted, o.value, o.support), fitted);
  // fewer (the moneyline at 0 and a line beside it): a line through them to the far end of the support would put the
  // median anywhere, so a normal through them instead, its mean where each point says it is, tighter quotes weighing more
  const usable = fitted.filter((p) => p.F > 0.02 && p.F < 0.98);
  if (usable.length && spec.sigma) {
    const sd = spec.sigma;
    const w = usable.map((p) => 1 / (p.spread + 0.01));
    const mean = usable.reduce((t, p, i) => t + w[i] * (p.x - sd * normInv(p.F)), 0) / w.reduce((t, x) => t + x, 0);
    return { ...pointView(`${name}, a normal through ${usable.length} price${usable.length > 1 ? 's' : ''}`, Dist.fromCdf(normalKnots(mean, sd)), fitted), thin: true };
  }
  throw new Unreadable(`no ${spec.shape === 'total' ? 'over/under' : 'spread or moneyline'} quoted within 10¢ in ${ev.slug}`);
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

/** One analog as fetched: viewed now, and again (src/models/event.ts) as its quotes stream in. */
export type Fetched = { venue: 'kalshi'; ev: KsEvent } | { venue: 'polymarket'; ev: PmEvent; refine?: PmEvent };

export async function fetchAnalog(spec: AnalogSpec): Promise<Fetched> {
  if (spec.venue === 'kalshi') return { venue: 'kalshi', ev: await ksEvent(spec.event) };
  const ev = await pmEvent(spec.slug);
  const refine = !isGame(spec) && !isLadder(spec) && spec.refine ? await pmEvent(spec.refine.slug).catch(() => undefined) : undefined;
  return { venue: 'polymarket', ev, refine };
}

/** A fetched analog at its quotes, and (when it reads) at its last trades: two views of one fetch. */
export function viewAnalog(spec: AnalogSpec, f: Fetched, o: AnalogOptions): { view: View; tape: View | null } {
  const attempt = (g: () => View): View | null => {
    try {
      return g();
    } catch {
      return null;
    }
  };
  if (spec.venue === 'kalshi' || f.venue === 'kalshi') {
    if (spec.venue !== 'kalshi' || f.venue !== 'kalshi') throw new Error(`${analogName(spec)}: fetched from the other venue`);
    return { view: viewKalshi(f.ev, spec, o), tape: attempt(() => viewKalshi(ksAtLastTrades(f.ev), spec, o)) };
  }
  const ev = f.ev;
  if (isGame(spec)) return { view: viewPmGame(ev, spec, o), tape: attempt(() => viewPmGame(atLastTrades(ev), spec, o)) };
  if (isLadder(spec)) return { view: viewPmLadder(ev, spec, o), tape: attempt(() => viewPmLadder(atLastTrades(ev), spec, o)) };
  return {
    view: viewPmBuckets(ev, spec, o, f.refine),
    tape: attempt(() => viewPmBuckets(atLastTrades(ev), spec, o, f.refine && atLastTrades(f.refine))),
  };
}

/** Fetches one analog and views it. */
export const readAnalogAndTape = async (spec: AnalogSpec, o: AnalogOptions): Promise<{ view: View; tape: View | null }> => viewAnalog(spec, await fetchAnalog(spec), o);

/** Its quotes stream (a game's lines move by the second in play): read them off Polymarket's socket between fetches. */
export const streams = (s: AnalogSpec): boolean => s.venue === 'polymarket' && isGame(s);

/** The tokens a streaming source's view reads (a game's ~35 lines for this number, of its ~300 markets). */
export function streamTokens(s: AnalogSpec, f: Fetched): string[] {
  if (s.venue !== 'polymarket' || !isGame(s) || f.venue !== 'polymarket') return [];
  return tradingMarkets(f.ev).flatMap((m) => (m.token && gameRange(m, s) ? [m.token] : []));
}

export const analogName = (s: AnalogSpec): string =>
  s.venue === 'kalshi' ? `Kalshi ${s.event}${s.mirror !== undefined ? ` (${s.mirror} − x)` : ''}` : `Polymarket ${s.slug}${isGame(s) ? ` (${s.shape})` : ''}`;
