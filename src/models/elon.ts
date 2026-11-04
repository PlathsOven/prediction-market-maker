// ELON-1d and ELON-7d: Elon Musk's posts on X since 2026-01-01 as Polymarket's XTracker counts them (Rizon's
// ELON-POSTS), at a contract's expiry, 1 or 7 days after its fill. That number is the count now (Rizon's
// price:ELON-POSTS, re-quoted on every post) plus X, the posts recorded over the horizon. Strikes sit on half
// posts, so a strike asks one question: at least this many more posts, or fewer?
//
// X's distribution comes from XTracker's own post history (90 days, by when each post was recorded):
//   - the rate: posts a day over the last 28 days (24-hour windows back from now), each day's weight halving every
//     7 days back, so a new pace counts within days;
//   - the spread: for horizons that started every 6 hours in the past, how far the posts they held strayed from
//     what that rate said when they began, as a ratio (posts + 1) / (expected + 1), recent ones weighing more (their
//     weight halves every 45 days back); centred on their median, so a past trend isn't carried forward;
//   - X = (rate × horizon + 1) × ratio − 1 for each, each sample spread over ±√(3x)/2 (half a Poisson's noise),
//     so the ladder steps smoothly.
// Over the 40 days to Oct 29 2026 (161 starts, every 6 hours), 1-day outcomes landed under the 46th percentile 45% of
// the time and over the 54th 46%. Plain whole-horizon windows, recency weighted, did worse (59% over the 54th): his
// pace doubled over those weeks, and a window lags it. Time of day and weekday add nothing a whole day doesn't
// already hold (a 1-day window covers every hour once; the weekday means were a few binges), and nor does the last
// day's pace (weighting it in scored worse: a spree fades within a day).
//
// Polymarket's own Elon windows (found through XTracker, which counts them) are the other view: the open window
// whose time left best matches the horizon (a week, a couple of days, a month), its median less the count so far,
// over that time left, as the horizon's worth. Its crowd knows things a history doesn't (a spree going on, a trip),
// so the forecast moves toward it: scaled by (Polymarket ÷ history) to the power fit / 2, fit = how well the
// window's time left matches the horizon (1 when equal), so halfway (in ratio) when they match; half that again when
// the window's book is thin (over 5¢ wide where its mass is). And while the two sit more than half the market's
// scale apart, the quotes widen. When Rizon's counter isn't live the book is held as
// it is: the exchange takes no orders on it after 2 minutes, and a post or two in the meantime is far inside the
// spread.
import type { Market } from '../api.ts';
import { type View, bucketView } from '../analogs.ts';
import { bucketDist, fitBuckets } from '../buckets.ts';
import { Dist, type Segment } from '../dist.ts';
import { type PmEvent, parseLabel, pmEvent, tradingMarkets } from '../sources/polymarket.ts';
import { type PostLog, type Tracking, trackingTotal, trackings } from '../sources/xtracker.ts';
import { type Built, type Check, DistModel, type Sizing, THIN_SPREAD, type Target, type Tick, Unreadable, disagreement, hold } from './model.ts';

const DAY = 86_400_000;
/** The rate looks back this many days... */
export const RATE_DAYS = 28;
/** ...each day's weight halving every this many days back. */
export const RATE_HALF_LIFE_DAYS = 7;
/** Past horizons start this far apart... */
export const RATIO_STEP_MS = 6 * 3_600_000;
/** ...and weigh half as much for every this many days back. */
export const RATIO_HALF_LIFE_DAYS = 45;
/** Fewer past horizons than this: too little to learn a spread from. */
const MIN_RATIOS = 20;
/** Each sample x is spread evenly over x ± SMOOTH × √(3x): sd SMOOTH × √x, half a Poisson count's. */
export const SMOOTH = 0.5;
/** The days of history read. */
export const HISTORY_DAYS = 90;

/** How many of the sorted times are at or before x. */
function upTo(times: readonly number[], x: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Posts recorded in (a, b]. */
export const countIn = (times: readonly number[], a: number, b: number): number => upTo(times, b) - upTo(times, a);

/** Posts a day at t: the RATE_DAYS 24-hour windows back from t, each weighing half the one after it RATE_HALF_LIFE_DAYS on. */
export function rateAt(times: readonly number[], t: number): number {
  let w = 0;
  let x = 0;
  for (let j = 1; j <= RATE_DAYS; j++) {
    const wj = 0.5 ** ((j - 0.5) / RATE_HALF_LIFE_DAYS);
    w += wj;
    x += wj * countIn(times, t - j * DAY, t - (j - 1) * DAY);
  }
  return x / w;
}

export interface Forecast {
  /** Posts a day lately. */
  rate: number;
  /** rate × horizon. */
  expected: number;
  /** X: the posts over the horizon. */
  dist: Dist;
  /** Past horizons learned from. */
  samples: number;
  /** Their median ratio, taken out (above 1: they ran ahead of the rate). */
  drift: number;
}

/** The weighted median of the r's. */
function weightedMedian(xs: readonly { r: number; w: number }[]): number {
  const s = [...xs].sort((a, b) => a.r - b.r);
  const half = s.reduce((t, x) => t + x.w, 0) / 2;
  let run = 0;
  for (const x of s) if ((run += x.w) >= half) return x.r;
  return 0;
}

/** X, the posts over the hMs after `at`, from the post times recorded in [from, at] (sorted). */
export function forecast(times: readonly number[], from: number, at: number, hMs: number): Forecast {
  const days = hMs / DAY;
  const expected = rateAt(times, at) * days;
  const ratios: { r: number; w: number }[] = [];
  for (let s = at - hMs; s - RATE_DAYS * DAY >= from; s -= RATIO_STEP_MS) {
    const e = rateAt(times, s) * days;
    ratios.push({ r: Math.log((countIn(times, s, s + hMs) + 1) / (e + 1)), w: 0.5 ** ((at - hMs - s) / (RATIO_HALF_LIFE_DAYS * DAY)) });
  }
  if (ratios.length < MIN_RATIOS) throw new Error(`only ${ratios.length} past ${days}-day horizons in the history`);
  const centre = weightedMedian(ratios);
  const segments: Segment[] = ratios.map(({ r, w }) => {
    const x = Math.max(0, (expected + 1) * Math.exp(r - centre) - 1);
    const b = Math.max(0.5, SMOOTH * Math.sqrt(3 * Math.max(x, 1)));
    return { lo: x - b, hi: x + b, p: w };
  });
  // fewer than no posts can't happen: a sample's spread under zero is cut off
  return { rate: expected / days, expected, dist: new Dist([], segments).truncate(-0.5), samples: ratios.length, drift: Math.exp(centre) };
}

/** A Polymarket event's count buckets (one window of posts), given the count so far: buckets under it are dead. */
export function viewCountBuckets(ev: PmEvent, count: number, support: readonly [number, number]): View {
  const buckets = tradingMarkets(ev).map((m) => {
    const range = parseLabel(m.label);
    if (!range) throw new Unreadable(`can't read the bucket "${m.label}" in ${ev.slug}`);
    return { label: m.label, bid: m.bid, ask: m.ask, last: m.last, range };
  });
  const fitted = fitBuckets(buckets);
  if (!fitted.length) throw new Unreadable(`no trading buckets in ${ev.slug}`);
  // the count can only rise: everything under it is gone
  return bucketView(`Polymarket ${ev.slug}`, bucketDist(fitted, { type: 'integer' }, support).truncate(count - 0.5), fitted);
}

/** How well a window's time left matches the horizon, as a ratio: 1 when they're equal. */
const fitOf = (t: Tracking, now: number, hMs: number): number => Math.min(t.end - now, hMs) / Math.max(t.end - now, hMs);

/**
 * The Polymarket window to check a horizon against: open now, with a Polymarket event and at least half the
 * horizon left, the one whose time left is nearest the horizon (as a ratio).
 */
export function windowFor(list: readonly Tracking[], now: number, hMs: number): Tracking | null {
  const open = list.filter((t) => t.slug && t.start <= now && t.end - now >= hMs / 2);
  return open.sort((a, b) => fitOf(b, now, hMs) - fitOf(a, now, hMs))[0] ?? null;
}

/** Polymarket's view of X, and how well its window matches the horizon: 1 when its time left is the horizon. */
export interface PolymarketView extends Check {
  fit: number;
  /** Its book is over THIN_SPREAD wide where the mass is. */
  thin?: boolean;
}

/** What Polymarket's best-matching window says X is: its median less the count so far, over its time left, as hMs's worth. */
export async function polymarketCheck(now: number, hMs: number): Promise<PolymarketView> {
  const t = windowFor(await trackings('elonmusk'), now, hMs);
  if (!t?.slug) throw new Error('no open Polymarket window to check against');
  const [total, ev] = await Promise.all([trackingTotal(t.id), pmEvent(t.slug)]);
  const v = viewCountBuckets(ev, total, [0, 10_000]);
  const left = v.dist.median() - total;
  const hoursLeft = (t.end - now) / 3_600_000;
  return {
    name: `Polymarket ${t.slug} (${Math.round(left)} more in its last ${hoursLeft.toFixed(0)} h)`,
    median: (left * hMs) / (t.end - now),
    fit: fitOf(t, now, hMs),
    thin: v.spread > THIN_SPREAD,
  };
}

/** How far the history's forecast moves toward Polymarket's: half the way (in ratio) for a window that matches. */
export const POLYMARKET_WEIGHT = 0.5;

/** The weight of Polymarket's view: POLYMARKET_WEIGHT × fit, halved for a thin book. */
export const polymarketWeight = (v: PolymarketView): number => POLYMARKET_WEIGHT * v.fit * (v.thin ? 0.5 : 1);

export class ElonModel extends DistModel {
  readonly source: string;
  readonly pollMs = 60_000;
  readonly follows = true;
  private readonly hMs: number;

  /** days: the market's horizon (1 or 7); log: the post history, shared by both books. */
  constructor(
    readonly days: number,
    private readonly log: PostLog,
    sizing: Sizing,
    private readonly check: (now: number, hMs: number) => Promise<PolymarketView> = polymarketCheck,
    /** Quote while the counter isn't live, rather than hold (an exchange that trades on a stand-in count). */
    private readonly quoteNotLive = false,
  ) {
    super(sizing);
    this.hMs = days * DAY;
    this.source = `XTracker's post history (${days}-day horizons) and Polymarket's Elon windows, around Rizon's count`;
  }

  protected async build(now: number): Promise<Built> {
    let stale: string | undefined;
    try {
      await this.log.refresh(now);
    } catch (err) {
      // a history up to an hour old still says the same thing about the next day or week
      if (!this.log.times.length || now - this.log.readAt > 3_600_000) throw err;
      stale = (err as Error).message;
    }
    const f = forecast(this.log.times, this.log.from, this.log.readAt, this.hMs);
    const median = f.dist.median();
    let pm: PolymarketView | null = null;
    let pmError: string | undefined;
    try {
      pm = await this.check(now, this.hMs);
    } catch (err) {
      pmError = (err as Error).message;
    }
    // toward Polymarket's crowd, by how well its window matches the horizon
    const w = pm ? polymarketWeight(pm) : 0;
    const k = pm ? ((pm.median + 1) / (median + 1)) ** w : 1;
    const dist = k === 1 ? f.dist : f.dist.scale(k);
    return {
      dist,
      thin: false,
      reports: [
        {
          name: `XTracker's post history, ${this.days}-day horizons`,
          weight: 1 - w,
          median,
          spread: 0,
          rows: [],
          note:
            `${f.rate.toFixed(1)} posts a day lately → ${f.expected.toFixed(1)} expected; spread from ${f.samples} past horizons ` +
            `(they ran ×${f.drift.toFixed(2)} their rate, taken out)${stale ? `; last read failed: ${stale}` : ''}`,
          ...(pmError && { error: `Polymarket: ${pmError}` }),
        },
        ...(pm ? [{ name: pm.name, weight: w, median: pm.median, spread: 0, rows: [], note: `posts to come${pm.thin ? ' (a thin book)' : ''}; the forecast scaled ×${k.toFixed(3)} toward it` }] : []),
      ],
      widen: disagreement(median, pm ? [pm] : [], this.guards),
    };
  }

  /** The count at expiry: the count now (the price channel's, else the listing's) plus X. */
  distOf(b: Built, m: Market, last?: Tick): Dist | string {
    const count = last?.price ?? m.spot;
    return count === null || count === undefined ? 'no count yet' : b.dist.shift(count);
  }

  target(m: Market, now: number, last?: Tick): Target {
    const count = last?.price ?? m.spot;
    if (!this.quoteNotLive && count !== null && count !== undefined && !(m.live && (last?.live ?? true))) return hold("Rizon's counter isn't live", count);
    return super.target(m, now, last);
  }
}
