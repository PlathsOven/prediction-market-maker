// Date markets: the number is the calendar day an event happens on, as a Julian Day Number, capped at the
// deadline (if it hasn't happened by the end of the deadline day, the value is the deadline). The analogs are
// ladders of dated yes/no markets: "IPO by Nov 20?" (cumulative: P(by the date)) or "ceasefire continues
// through Nov 15?" (survival: P(not by the date)).
//
// Each dated market's cutoff is the end of its date in the venue's time zone (11:59 PM ET; 11:59 PM Iran time),
// placed on our market's own axis: the Julian Date on the market's clock (UTC, or ET for an ET calendar date).
// The event hasn't happened yet, so the CDF starts at 0 now; it runs linearly between cutoffs, and whatever is
// left at the deadline day's start is a point mass on the deadline.
import { fitBuckets, fitPoints, type LadderPoint } from '../buckets.ts';
import { Dist, type Segment } from '../dist.ts';
import { axisOf, endOfDayIn, jdnOf, jdnOfDay } from '../grid.ts';
import { type View, bucketView, pointView } from '../analogs.ts';
import { type PmEvent, atLastTrades, parseDateLabel, pmEvent, tradingMarkets } from '../sources/polymarket.ts';
import { type Built, type Check, DistModel, type Sizing, type SourceReport, THIN_SPREAD, Unreadable, disagreement } from './model.ts';

export interface DateSource {
  venue: 'polymarket';
  slug: string;
  /** cumulative: each market pays if the event happens by its date; survival: if it hasn't. */
  shape: 'cumulative' | 'survival';
  /** The zone the venue's dates end in ("by 11:59 PM ET": America/New_York). */
  zone: string;
  weight?: number;
}

export interface DateOptions {
  /** The zone whose calendar day is the market's value (UTC, America/New_York). */
  zone: string;
  now: number;
  /** The deadline's JDN. */
  deadline: number;
}

/** A dated ladder as a distribution of the event's day (JDN), on the market's clock. */
export function viewPmDates(ev: PmEvent, src: DateSource, o: DateOptions): View {
  const axisNow = axisOf(o.now, o.zone);
  const points: LadderPoint[] = tradingMarkets(ev).flatMap((m) => {
    const d = parseDateLabel(m.label, m.endDate);
    if (!d) throw new Unreadable(`can't read the date "${m.label}" in ${ev.slug}`);
    const x = axisOf(endOfDayIn(jdnOfDay(d.y, d.m, d.d), src.zone), o.zone);
    // a date already past and not yet resolved says nothing new
    return x > axisNow ? [{ label: m.label, bid: m.bid, ask: m.ask, last: m.last, x, survival: src.shape === 'survival' }] : [];
  });
  const fitted = fitPoints(points);
  if (!fitted.length) throw new Unreadable(`no readable dates in ${ev.slug}`);
  const knots: [number, number][] = [[axisNow, 0], ...fitted.map((p): [number, number] => [p.x, p.F])];
  const [lastX, lastF] = knots[knots.length - 1];
  // past the ladder's last date, what's left waits at the deadline
  if (lastX < o.deadline) knots.push([o.deadline, lastF]);
  return pointView(`Polymarket ${ev.slug}`, Dist.fromCdf(knots).capAt(o.deadline), fitted);
}

/** A check on a date market: an event of day buckets on the same question ("IPO on Nov 18?" … "No IPO by Nov 30"). */
export interface DayBuckets {
  venue: 'polymarket';
  slug: string;
  shape: 'days';
  /** The zone its days are in. */
  zone: string;
}

/**
 * A day-bucket event as a distribution of the day, on the market's clock: each day's bucket spread over that day,
 * "Nov 13 or earlier" from now to the end of Nov 13, "No IPO by Nov 30" from then to the deadline.
 */
export function viewPmDays(ev: PmEvent, src: DayBuckets, o: DateOptions): View {
  const axisNow = axisOf(o.now, o.zone);
  const buckets = tradingMarkets(ev).map((m) => {
    const d = parseDateLabel(m.label, m.endDate);
    if (!d) throw new Unreadable(`can't read the day "${m.label}" in ${ev.slug}`);
    const end = axisOf(endOfDayIn(jdnOfDay(d.y, d.m, d.d), src.zone), o.zone);
    const label = m.label.toLowerCase();
    const [lo, hi] = /^no |^not /.test(label) ? [end, o.deadline + 0.5] : /earlier|prior|before/.test(label) ? [axisNow, end] : [end - 1, end];
    return { label: m.label, bid: m.bid, ask: m.ask, last: m.last, range: { kind: 'exact' as const, a: 0 }, lo, hi };
  });
  const fitted = fitBuckets(buckets);
  if (!fitted.length) throw new Unreadable(`no trading days in ${ev.slug}`);
  const segments: Segment[] = fitted.map((b) => ({ lo: Math.max(b.lo, axisNow), hi: Math.max(b.hi, axisNow + 1e-6), p: b.p }));
  return bucketView(`Polymarket ${ev.slug}`, new Dist([], segments).capAt(o.deadline), fitted);
}

export class DateModel extends DistModel {
  readonly source: string;

  /** deadline: the market's deadline (ms), read from the exchange's listing each refresh. checks: read beside, not mixed in. */
  constructor(
    private readonly sources: readonly DateSource[],
    private readonly zone: string,
    private readonly deadline: () => number,
    sizing: Sizing,
    private readonly checks: readonly DayBuckets[] = [],
  ) {
    super(sizing);
    this.source = sources.map((s) => `Polymarket ${s.slug}`).join(' + ');
  }

  protected async build(now: number): Promise<Built> {
    const o = { zone: this.zone, now, deadline: jdnOf(this.deadline()) };
    const read = await Promise.allSettled(
      this.sources.map(async (src) => {
        const event = await pmEvent(src.slug);
        return { view: viewPmDates(event, src, o), event, src, w: src.weight ?? 1 };
      }),
    );
    const ok = read.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    // every source failed: the first one's reason
    if (!ok.length) throw (read[0] as PromiseRejectedResult).reason;
    const total = ok.reduce((t, x) => t + x.w, 0);
    const dist = Dist.mix(ok.map((x) => [x.view.dist, x.w] as const));
    const spread = ok.reduce((t, x) => t + (x.w / total) * x.view.spread, 0);
    const reports: SourceReport[] = ok.map((x) => ({ name: x.view.name, weight: x.w / total, median: x.view.dist.median(), spread: x.view.spread, rows: x.view.rows }));
    // checks: the same ladders at their last trades, and any day-bucket events on the question
    const checks: Check[] = [];
    for (const x of ok) {
      try {
        checks.push({ name: `${x.view.name} at its last trades`, median: viewPmDates(atLastTrades(x.event), x.src, o).dist.median() });
      } catch {}
    }
    for (const c of this.checks) {
      try {
        const v = viewPmDays(await pmEvent(c.slug), c, o);
        checks.push({ name: v.name, median: v.dist.median() });
        reports.push({ name: v.name, weight: 0, median: v.dist.median(), spread: v.spread, rows: v.rows, note: 'a check: read beside the sources, not mixed in' });
      } catch {}
    }
    for (const c of checks) if (!reports.some((r) => r.name === c.name)) reports.push({ name: c.name, weight: 0, median: c.median, spread: 0, rows: [], note: 'a check' });
    return { dist, thin: spread > THIN_SPREAD, reports, widen: disagreement(dist.median(), checks, this.guards) };
  }
}
