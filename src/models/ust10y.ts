// UST10Y-MAX-2026: the highest daily 10-year par yield close from 2026-10-29 through 2026-12-31.
//
// The analog is Polymarket's "hit" ladder ("will the 10-year yield hit 5.4% before 2027?"): each market is a point
// on the survival curve of the running maximum M, P(M ≥ x). Two facts pin the rest:
//   the floor: M is at least the highest close in the window so far (Treasury's CSV, FRED's DGS10 as a backup);
//   the shape below the lowest open threshold: for a driftless walk starting at today's close x0, the reflection
//     principle gives P(M ≥ x) = 2 (1 − Φ((x − x0) / s)) for x ≥ x0. s is fitted so the curve meets the lowest
//     open threshold's price; above it the ladder's own points take over. When the walk starts under the floor,
//     the chance it never gets back up to it is a point mass on the floor.
import { fitPoints, type LadderPoint, pointSpread } from '../buckets.ts';
import { Dist, normCdf, normInv } from '../dist.ts';
import type { View } from '../analogs.ts';
import { type PmEvent, atLastTrades, parseLabel, pmEvent, tradingMarkets } from '../sources/polymarket.ts';
import { type Close, fredCloses, mergeCloses, treasuryCloses } from '../sources/treasury.ts';
import { type Built, type Check, DistModel, type Sizing, THIN_SPREAD, Unreadable, disagreement } from './model.ts';

export interface MaxYieldOptions {
  /** The window's first day (YYYY-MM-DD). */
  from: string;
  /** Its last day: business days left set the fallback width. */
  to: string;
  /** Where the curve's top end stops (the yield, in percent). */
  cap: number;
  now: number;
}

/** A 10-year yield's typical daily move, in points, for when no threshold is readable. */
const DAILY_MOVE = 0.07;

/** Weekdays from tomorrow through `to` (YYYY-MM-DD). */
export function businessDaysLeft(now: number, to: string): number {
  let n = 0;
  for (let t = now + 86_400_000; new Date(t).toISOString().slice(0, 10) <= to; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

export function viewMaxYield(ev: PmEvent, closes: readonly Close[], o: MaxYieldOptions): View & { note: string; thin: boolean } {
  const latest = closes.at(-1);
  if (!latest) throw new Unreadable('no yield closes');
  const x0 = latest.value;
  const window = closes.filter((c) => c.day >= o.from && c.day <= o.to);
  const floor = window.length ? Math.max(...window.map((c) => c.value)) : null;
  const anchor = Math.max(x0, floor ?? x0);
  const points: LadderPoint[] = tradingMarkets(ev).map((m) => {
    const r = parseLabel(m.label);
    if (!r || r.kind !== 'exact') throw new Unreadable(`can't read the threshold "${m.label}" in ${ev.slug}`);
    // "hit x": M ≥ x, a survival point (continuous, so the edge doesn't matter)
    return { label: m.label, bid: m.bid, ask: m.ask, last: m.last, x: r.a, survival: true };
  });
  const fitted = fitPoints(points).filter((p) => p.x > anchor + 1e-9);
  const first = fitted[0];
  const s1 = first ? 1 - first.F : null;
  const fallback = DAILY_MOVE * Math.sqrt(Math.max(1, businessDaysLeft(o.now, o.to)));
  const s = first && s1! > 0 && s1! < 1 && first.x > x0 ? (first.x - x0) / normInv(1 - s1! / 2) : fallback;
  const reach = (x: number) => (x <= x0 ? 1 : Math.min(1, 2 * (1 - normCdf((x - x0) / s))));
  const top = first ? first.x : Math.min(o.cap, anchor + 4 * s);
  const knots: [number, number][] = [];
  for (let i = 0; i <= 12; i++) {
    const x = anchor + ((top - anchor) * i) / 12;
    knots.push([x, 1 - reach(x)]);
  }
  for (const p of fitted.slice(1)) knots.push([p.x, Math.max(p.F, knots[knots.length - 1][1])]);
  knots.push([Math.max(o.cap, knots[knots.length - 1][0] + 0.01), 1]);
  // the reflected curve meets the first threshold exactly (s was fitted to it): keep the venue's own value there
  if (first) knots[12][1] = first.F;
  const spread = fitted.length ? pointSpread(fitted) : 1;
  return {
    name: `Polymarket ${ev.slug}`,
    dist: Dist.fromCdf(knots),
    spread,
    thin: !first || spread > THIN_SPREAD,
    rows: fitted.map((p) => ({ label: p.label, bid: p.bid, ask: p.ask, p: 1 - p.F })),
    note: `latest close ${x0.toFixed(2)}% (${latest.day}) · window high ${floor === null ? 'none yet' : `${floor.toFixed(2)}%`} · s ${s.toFixed(3)}${first ? '' : ' (no open threshold: from the typical daily move)'}`,
  };
}

export class MaxYieldModel extends DistModel {
  readonly source: string;

  constructor(
    private readonly slug: string,
    private readonly window: { from: string; to: string; cap: number },
    sizing: Sizing,
  ) {
    super(sizing);
    this.source = `Polymarket ${slug} + Treasury 10 Yr closes`;
  }

  protected async build(now: number): Promise<Built> {
    const year = Number(this.window.from.slice(0, 4));
    const fredFrom = new Date(Date.parse(this.window.from) - 14 * 86_400_000).toISOString().slice(0, 10);
    const [ev, treasury, fred] = await Promise.all([
      pmEvent(this.slug),
      treasuryCloses(year).catch(() => [] as Close[]),
      fredCloses('DGS10', fredFrom).catch(() => [] as Close[]),
    ]);
    const closes = mergeCloses(treasury, fred);
    if (!closes.length) throw new Error('no yield closes from Treasury or FRED');
    const v = viewMaxYield(ev, closes, { ...this.window, now });
    const checks: Check[] = [];
    try {
      checks.push({ name: `${v.name} at its last trades`, median: viewMaxYield(atLastTrades(ev), closes, { ...this.window, now }).dist.median() });
    } catch {}
    return {
      dist: v.dist,
      thin: v.thin,
      reports: [
        { name: v.name, weight: 1, median: v.dist.median(), spread: v.spread, rows: v.rows, note: v.note },
        ...checks.map((c) => ({ name: c.name, weight: 0, median: c.median, spread: 0, rows: [], note: 'a check' })),
      ],
      widen: disagreement(v.dist.median(), checks, this.guards),
    };
  }
}
