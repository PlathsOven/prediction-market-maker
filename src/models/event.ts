// Event markets read off their analogs: each source (a Polymarket or Kalshi event on the same question) becomes a
// distribution of our number, and the market's distribution is their mixture, weighted as configured. A source
// whose request fails keeps its last read for up to 10 minutes; one that answers with something unreadable drops
// out at once. The others' weights grow to fill in, and the market stops quoting when none is left (or, on a market
// with a prior, goes back to the prior until its time is up).
//
// Sources whose quotes stream (a game's lines on Polymarket) are fetched like the rest, for which markets the event
// has, and then re-viewed on every change of their books on Polymarket's socket (at most once a LIVE_MS), so the
// book follows a score within a second rather than at the next poll. While the socket has their books, they alone
// make the fair value: a polled source can be 45 s behind, and mixed in it would hold back every move until its next
// read. The polled sources are checks meanwhile (a stale one widens the quotes); with the socket down, all mix.
//
// Every read is also checked: each source's own median, each source at its last trades (the tape) and any checks
// configured for the market (related events, read beside the sources but not mixed in). Any of them more than half
// the market's scale from the fair value widens the quotes. Two sources moving the same way together count as a
// confirmed move.
import { type AnalogOptions, type AnalogSpec, type Fetched, type View, analogName, fetchAnalog, readAnalogAndTape, streamTokens, streams, viewAnalog } from '../analogs.ts';
import { Dist } from '../dist.ts';
import { type LiveFeed, pmLive, withLive } from '../sources/polymarket-live.ts';
import { type Built, type Check, DistModel, STALE_MS, type Sizing, type SourceReport, THIN_SPREAD, Unreadable, disagreement } from './model.ts';

export interface Prior {
  /** CDF knots [x, P(X ≤ x)]. */
  knots: [number, number][];
  why: string;
  /** When it stops being used (ms). */
  until: number;
}

/** A streaming source is re-viewed at most this often: a burst of book changes is one re-quote. */
export const LIVE_MS = 1_000;

export class EventModel extends DistModel {
  readonly source: string;
  /** Each source's last good fetch; null after an unreadable one. */
  private readonly fetched: ({ f: Fetched; at: number } | null)[];
  /** Each source's last fetch error, if its last fetch failed. */
  private readonly errors: ({ message: string; unreadable: boolean } | undefined)[];
  /** Each source's last view, whose median a move is measured from. */
  private readonly views: (View | null)[];
  private checked: SourceReport[] = [];
  private wake: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** checks: other analogs read beside the sources, never mixed in. */
  constructor(
    private readonly sources: readonly AnalogSpec[],
    private readonly opts: AnalogOptions,
    sizing: Sizing,
    private readonly checks: readonly AnalogSpec[] = [],
    /** What to quote until a source lists the market (a game, about a week out), never after `until`. */
    private readonly prior?: Prior,
    private readonly feed: LiveFeed = pmLive,
  ) {
    super(sizing);
    this.source = sources.map(analogName).join(' + ') + (sources.some(streams) ? ' (streaming Polymarket’s books)' : '');
    this.fetched = sources.map(() => null);
    this.errors = sources.map(() => undefined);
    this.views = sources.map(() => null);
  }

  listen(wake: () => void): void {
    this.wake = wake;
    this.follow();
  }

  close(): void {
    this.wake = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.feed.unwatch(this);
  }

  protected async build(now: number): Promise<Built> {
    const read = await Promise.allSettled(this.sources.map((s) => fetchAnalog(s)));
    read.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        this.fetched[i] = { f: r.value, at: now };
        this.errors[i] = undefined;
        return;
      }
      const unreadable = r.reason instanceof Unreadable;
      this.errors[i] = { message: (r.reason as Error).message, unreadable };
      if (unreadable) this.fetched[i] = null;
    });
    this.checked = [];
    for (const spec of this.checks) {
      try {
        const { view: v } = await readAnalogAndTape(spec, this.opts);
        this.checked.push({ name: v.name, weight: 0, median: v.dist.median(), spread: v.spread, rows: v.rows, note: 'a check: read beside the sources, not mixed in' });
      } catch {}
    }
    this.follow();
    return this.compose(now);
  }

  /** Follows the streaming sources' tokens, once the runner listens. */
  private follow(): void {
    if (!this.wake) return;
    const tokens = this.sources.flatMap((s, i) => (this.fetched[i] ? streamTokens(s, this.fetched[i]!.f) : []));
    if (tokens.length) this.feed.watch(this, tokens, () => this.pushed());
  }

  /** A streaming source's book changed: re-view what's fetched, within LIVE_MS. */
  private pushed(): void {
    if (this.timer || !this.wake) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.wake) return;
      const now = Date.now();
      try {
        this.accept(this.compose(now), now);
      } catch (err) {
        this.failed(err as Error);
      }
      this.wake();
    }, LIVE_MS);
  }

  /** The fetched sources, viewed at their quotes now (a streaming one's from the socket), and mixed. */
  private compose(now: number): Built {
    const before = this.views.map((v) => v?.dist.median() ?? null);
    const reports: SourceReport[] = [];
    const tapes: Check[] = [];
    const ok: { view: View; w: number; i: number; live: boolean }[] = [];
    const unreadable: boolean[] = [];
    this.sources.forEach((spec, i) => {
      const got = this.fetched[i];
      const kept = got && now - got.at <= STALE_MS ? got : null;
      let error = this.errors[i] && `${this.errors[i]!.message}${kept ? ' (using the last read)' : ''}`;
      let view: View | null = null;
      let live = false;
      unreadable[i] = !kept && this.errors[i]?.unreadable === true;
      if (kept) {
        try {
          let f = kept.f;
          if (streams(spec) && f.venue === 'polymarket') {
            live = f.ev.markets.some((m) => m.token !== null && this.feed.top(m.token) !== null);
            f = { ...f, ev: withLive(f.ev, this.feed) };
          }
          const r = viewAnalog(spec, f, this.opts);
          view = r.view;
          if (r.tape) tapes.push({ name: `${r.view.name} at its last trades`, median: r.tape.dist.median() });
        } catch (err) {
          error = (err as Error).message;
          unreadable[i] = err instanceof Unreadable;
        }
      }
      this.views[i] = view;
      if (view) ok.push({ view, w: spec.weight ?? 1, i, live });
      reports.push(
        view
          ? { name: view.name, weight: 0, median: view.dist.median(), spread: view.spread, rows: view.rows, ...(error && { error }) }
          : { name: analogName(spec), weight: 0, median: null, spread: 1, rows: [], error },
      );
    });
    if (!ok.length && this.prior && now < this.prior.until) {
      const dist = Dist.fromCdf(this.prior.knots);
      return { dist, thin: true, reports: [{ name: `prior: ${this.prior.why}`, weight: 1, median: dist.median(), spread: 0, rows: [] }, ...reports] };
    }
    if (!ok.length) {
      const msg = reports.map((r) => r.error).filter(Boolean).join('; ');
      throw unreadable.every(Boolean) ? new Unreadable(msg) : new Error(msg || 'no source');
    }
    const streaming = ok.filter((x) => x.live);
    const mixed = streaming.length ? streaming : ok;
    for (const x of ok) if (!mixed.includes(x)) reports[x.i].note = 'a check while Polymarket streams: its last read can be 45 s old';
    const total = mixed.reduce((t, x) => t + x.w, 0);
    for (const x of mixed) reports[x.i].weight = x.w / total;
    const dist = Dist.mix(mixed.map((x) => [x.view.dist, x.w] as const));
    const spread = mixed.reduce((t, x) => t + (x.w / total) * x.view.spread, 0);
    const median = dist.median();

    const checks: Check[] = [
      ...ok.filter((x) => x.w > 0).map((x) => ({ name: x.view.name, median: x.view.dist.median() })),
      ...tapes,
      ...this.checked.map((c) => ({ name: c.name, median: c.median! })),
    ];
    reports.push(...this.checked);
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
    return { dist, thin: spread > THIN_SPREAD || mixed.some((x) => x.view.thin), reports, widen: disagreement(median, checks, g), corroborated };
  }
}
