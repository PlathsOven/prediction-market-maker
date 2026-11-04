// Event markets read off their analogs: each source (a Polymarket or Kalshi event on the same question) becomes a
// distribution of our number, and the market's distribution is their mixture, weighted as configured. A source
// whose request fails keeps its last read for up to 10 minutes; one that answers with something unreadable drops
// out at once. The others' weights grow to fill in, and the market stops quoting when none is left (or, on a market
// with a prior, goes back to the prior until its time is up).
//
// Every read is also checked: each source's own median, each source at its last trades (the tape) and any checks
// configured for the market (related events, read beside the sources but not mixed in). Any of them more than half
// the market's scale from the fair value widens the quotes. Two sources moving the same way together count as a
// confirmed move.
import { type AnalogOptions, type AnalogSpec, type View, analogName, readAnalogAndTape } from '../analogs.ts';
import { Dist } from '../dist.ts';
import { type Built, type Check, DistModel, STALE_MS, type Sizing, type SourceReport, THIN_SPREAD, Unreadable, disagreement } from './model.ts';

export interface Prior {
  /** CDF knots [x, P(X ≤ x)]. */
  knots: [number, number][];
  why: string;
  /** When it stops being used (ms). */
  until: number;
}

export class EventModel extends DistModel {
  readonly source: string;
  private readonly last: ({ view: View; at: number } | null)[];

  /** checks: other analogs read beside the sources, never mixed in. */
  constructor(
    private readonly sources: readonly AnalogSpec[],
    private readonly opts: AnalogOptions,
    sizing: Sizing,
    private readonly checks: readonly AnalogSpec[] = [],
    /** What to quote until a source lists the market (a game, about a week out), never after `until`. */
    private readonly prior?: Prior,
  ) {
    super(sizing);
    this.source = sources.map(analogName).join(' + ');
    this.last = sources.map(() => null);
  }

  protected async build(now: number): Promise<Built> {
    const read = await Promise.allSettled(this.sources.map((s) => readAnalogAndTape(s, this.opts)));
    const before = this.last.map((x) => x?.view.dist.median() ?? null);
    const reports: SourceReport[] = [];
    const tapes: Check[] = [];
    const ok: { view: View; w: number; i: number }[] = [];
    read.forEach((r, i) => {
      const spec = this.sources[i];
      if (r.status === 'fulfilled') {
        this.last[i] = { view: r.value.view, at: now };
        if (r.value.tape) tapes.push({ name: `${r.value.view.name} at its last trades`, median: r.value.tape.dist.median() });
      } else if (r.reason instanceof Unreadable) this.last[i] = null;
      const kept = this.last[i] && now - this.last[i]!.at <= STALE_MS ? this.last[i]!.view : null;
      const error = r.status === 'rejected' ? (r.reason as Error).message : undefined;
      if (kept) ok.push({ view: kept, w: spec.weight ?? 1, i });
      reports.push(
        kept
          ? { name: kept.name, weight: 0, median: kept.dist.median(), spread: kept.spread, rows: kept.rows, ...(error && { error: `${error} (using the last read)` }) }
          : { name: analogName(spec), weight: 0, median: null, spread: 1, rows: [], error },
      );
    });
    if (!ok.length && this.prior && now < this.prior.until) {
      const dist = Dist.fromCdf(this.prior.knots);
      return { dist, thin: true, reports: [{ name: `prior: ${this.prior.why}`, weight: 1, median: dist.median(), spread: 0, rows: [] }, ...reports] };
    }
    if (!ok.length) {
      const unreadable = read.every((r) => r.status === 'rejected' && r.reason instanceof Unreadable);
      const msg = reports.map((r) => r.error).filter(Boolean).join('; ');
      throw unreadable ? new Unreadable(msg) : new Error(msg || 'no source');
    }
    const total = ok.reduce((t, x) => t + x.w, 0);
    for (const x of ok) reports[x.i].weight = x.w / total;
    const dist = Dist.mix(ok.map((x) => [x.view.dist, x.w] as const));
    const spread = ok.reduce((t, x) => t + (x.w / total) * x.view.spread, 0);
    const median = dist.median();

    const checks: Check[] = [...ok.filter((x) => x.w > 0).map((x) => ({ name: x.view.name, median: x.view.dist.median() })), ...tapes];
    for (const spec of this.checks) {
      try {
        const { view: v } = await readAnalogAndTape(spec, this.opts);
        checks.push({ name: v.name, median: v.dist.median() });
        reports.push({ name: v.name, weight: 0, median: v.dist.median(), spread: v.spread, rows: v.rows, note: 'a check: read beside the sources, not mixed in' });
      } catch {}
    }
    for (const t of tapes) reports.push({ name: t.name, weight: 0, median: t.median, spread: 0, rows: [], note: 'a check' });

    // two sources that moved the same way, each by half the market's scale or more, confirm a big move at once
    const prev = this.built?.dist.median();
    const g = this.guards;
    let corroborated = false;
    if (g && prev !== undefined && ok.length >= 2) {
      const dir = Math.sign(median - prev);
      const movers = ok.filter((x) => {
        const b = before[x.i];
        const d = x.view.dist.median() - (b ?? NaN);
        return b !== null && Math.abs(d) >= g.scale / 2 && Math.sign(d) === dir;
      });
      corroborated = movers.length >= 2;
    }
    return { dist, thin: spread > THIN_SPREAD, reports, widen: disagreement(median, checks, g), corroborated };
  }
}
