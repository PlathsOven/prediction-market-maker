// What every model gives the runner: for one market, the ladder it wants resting now.
//
// Feed models (BTC, Gold) re-quote on every price; distribution models (everything that reads another venue, a
// status page or a post history) poll their sources every 45-60 s, keep the distribution they built, and quote it
// with the quantile ladder (ELON's also re-quote on every post, around the count; an NFL game's on every change of
// its Polymarket lines, which stream). Their fair value (the
// distribution's median) is guarded, and the book stays two-sided wherever that's safe:
//   - outside the market's sane range it isn't quoted at all;
//   - a move bigger than the market's typical scale between two reads waits for a read CONFIRM_MS later to confirm it (or
//     for two sources moving together); meanwhile the book quotes only what's safe under both reads, so it widens
//     to span the old and the new fair value;
//   - sources that disagree, or an incident today on an uptime, widen the quotes;
//   - sources that fail keep their last read: 10 minutes on, the quotes widen; 2 hours on, they come down. A source
//     that answers with something the model can't read (a format it doesn't know, an event that's closed) takes
//     them down at once.
import type { Market } from '../api.ts';
import type { Dist } from '../dist.ts';
import { type Grid, gridOf, jdnOf } from '../grid.ts';
import { type LadderOptions, type Quote, quantileLadder } from '../ladder.ts';

export interface Target {
  quotes: Quote[];
  /** Where the ladder centres (spot, or the implied median): new quotes nearest it go out first. */
  center: number;
  /** Why nothing (or only one side) is quoted. */
  reason?: string;
  /** Why the quotes are wider than usual (sources disagree, a stale source), when they are. */
  note?: string;
  /**
   * Leave the resting quotes as they are, neither moved nor canceled: the number can't be read just now, and the
   * exchange takes no orders until it can (a price feed that's down), so they can't be traded meanwhile.
   */
  hold?: boolean;
}

export interface Tick {
  price: number;
  live: boolean;
  /** When it arrived here (this machine's clock), to tell how fresh it is. */
  at: number;
}

export interface Model {
  /** For logs: where its view comes from. */
  readonly source: string;
  /** Polled models: how often to refresh. */
  readonly pollMs?: number;
  /** It quotes off the underlying's price channel (re-quoting on every price). */
  readonly follows?: boolean;
  /** Reads the model's sources. */
  refresh?(now: number): Promise<void>;
  /** Streams its sources between reads: wake is called whenever that changes its quotes (a socket's price moved). */
  listen?(wake: () => void): void;
  /** Stops streaming (the market closed, or the runner stopped). */
  close?(): void;
  /** The quotes for market m now; last is the underlying's latest price, when there is one. */
  target(m: Market, now: number, last?: Tick): Target;
}

/** The answer when there's nothing to quote. */
export const none = (reason: string, center = 0): Target => ({ quotes: [], center, reason });

/** The answer when the quotes resting now should stay as they are (see Target.hold). */
export const hold = (reason: string, center: number): Target => ({ quotes: [], center, reason: `${reason}: quotes left as they are`, hold: true });

/** A source answered with something the model can't read: quoting stops at once, not after the stale timeout. */
export class Unreadable extends Error {}

/** After this long without a good read a distribution model's quotes widen (by STALE_WIDEN)... */
export const STALE_MS = 10 * 60_000;
/** ...and after this long they come down. */
export const STALE_LIMIT_MS = 2 * 3_600_000;
export const STALE_WIDEN = 0.08;
/** Extra margin while sources disagree (or a check disagrees with them) by more than half the market's scale. */
export const DISAGREE_WIDEN = 0.03;
/**
 * A big move is believed once a read this much later says it again. Polled models read 45-60 s apart, so it's the
 * next read; a streaming one re-reads on every price, and a misprint can sit in a book for a few seconds.
 */
export const CONFIRM_MS = 10_000;
/** Above this probability-weighted spread (in price, 0-1), a source is thin, and its market is quoted wider. */
export const THIN_SPREAD = 0.05;

export interface Sizing {
  /** The quantile ladder, before any thin-source widening. */
  ladder: LadderOptions;
  /** The margin when the sources are thin. */
  thinMargin: number;
}

/** One source as last read, for logs and the read command. */
export interface SourceReport {
  name: string;
  weight: number;
  /** Its own implied median, in the market's units. */
  median: number | null;
  /** Probability-weighted bid-ask spread where its mass is. */
  spread: number;
  rows: { label: string; bid: number | null; ask: number | null; p: number }[];
  error?: string;
  /** Anything else worth a line (a floor, a fitted volatility). */
  note?: string;
}

export interface Built {
  dist: Dist;
  thin: boolean;
  reports: SourceReport[];
  /** Pull the book (an outage going on now): the view is fine, but the next minutes aren't like the history. */
  unsure?: string;
  /** Quote wider than usual by this much margin, and why. */
  widen?: { by: number; why: string };
  /** Two or more sources moved together: a big move needs no second read. */
  corroborated?: boolean;
}

/** How a market's fair value is checked, in its own units. */
export interface Guards {
  /** Its typical move: a fair value moving further between two reads waits for a second; sources half this far apart widen the quotes. */
  scale: number;
  /** Where a fair value is plausible at all: outside it nothing is quoted. */
  sane?: readonly [number, number];
}

/** The strikes a market takes now: its grid and bounds, and on a date market tonight's midnight to the deadline's. */
export function strikesOf(m: Market, now: number): Grid {
  const g = gridOf(m);
  if (m.kind === 'date') {
    const today = jdnOf(now) + 0.5;
    const last = m.deadline ? jdnOf(m.deadline) - 0.5 : null;
    return { ...g, min: Math.max(g.min ?? today, today), max: last === null ? g.max : Math.min(g.max ?? last, last) };
  }
  return g;
}

/** A model that polls its sources, builds a distribution of the market's number and quotes its quantiles. */
export abstract class DistModel implements Model {
  abstract readonly source: string;
  readonly pollMs: number = 45_000;
  built: Built | null = null;
  readAt = -Infinity;
  problem: string | null = null;
  /** A big move waiting for a second read: why the book is quoted wider meanwhile. */
  held: string | null = null;
  /** The read that moved it, until a later one confirms it, and when the move was first seen. */
  private pending: Built | null = null;
  private pendingAt = -Infinity;
  /** Margin over the default for this market (a small sample). */
  protected marginFloor = 0;
  /** Set by the market table (src/markets.ts); none: no checks. */
  guards: Guards | null = null;

  constructor(protected readonly sizing: Sizing) {}

  protected abstract build(now: number): Promise<Built>;

  async refresh(now: number): Promise<void> {
    let b: Built;
    try {
      b = await this.build(now);
    } catch (err) {
      this.failed(err as Error);
      return;
    }
    this.accept(b, now);
  }

  /** A read that failed: an unreadable source takes the quotes down at once; any other failure keeps the last read. */
  protected failed(err: Error): void {
    this.problem = err.message;
    if (err instanceof Unreadable) this.built = null;
  }

  /** A read, through the guards: outside the sane range it's refused; a big move waits for a later read to confirm it. */
  protected accept(b: Built, now: number): void {
    const median = b.dist.median();
    const g = this.guards;
    if (g?.sane && (median < g.sane[0] || median > g.sane[1])) {
      this.built = null;
      this.problem = `fair value ${round(median)} is outside its sane range ${g.sane[0]} to ${g.sane[1]}`;
      return;
    }
    const prev = this.built && now - this.readAt <= STALE_LIMIT_MS ? this.built.dist.median() : null;
    if (g && prev !== null && Math.abs(median - prev) > g.scale && !b.corroborated) {
      // a big move from one source: believe it when a read CONFIRM_MS later says it again
      const agrees = this.pending !== null && Math.abs(this.pending.dist.median() - median) <= g.scale / 2;
      if (!agrees) this.pendingAt = now;
      if (!agrees || now - this.pendingAt < CONFIRM_MS) {
        this.pending = b;
        this.held = `fair value moved from ${round(prev)} to ${round(median)}: waiting for a second read`;
        return;
      }
    }
    this.built = b;
    this.readAt = now;
    this.problem = null;
    this.held = null;
    this.pending = null;
  }

  /** The distribution to quote now: one read within the last 2 hours. */
  current(now: number): Built | null {
    return this.built && now - this.readAt <= STALE_LIMIT_MS ? this.built : null;
  }

  /** The distribution of the market's number in a read (a count's model adds the count so far); a string: why there's none. */
  distOf(b: Built, _m: Market, _last?: Tick): Dist | string {
    return b.dist;
  }

  target(m: Market, now: number, last?: Tick): Target {
    const b = this.current(now);
    if (!b) return none(this.problem ? `source: ${this.problem}` : this.built ? 'source stale for 2 hours' : 'no read yet');
    const d = this.distOf(b, m, last);
    if (typeof d === 'string') return none(d);
    if (b.unsure) return none(b.unsure, d.median());
    const t = this.ladder(m, now, b, d);
    // a big move the next read hasn't confirmed: only what's safe under both reads, the old and the new
    const p = this.held ? this.pending : null;
    const dp = p ? this.distOf(p, m, last) : null;
    if (!p || !dp || typeof dp === 'string') return t;
    if (p.unsure) return none(p.unsure, d.median());
    const quotes = envelope(t.quotes, this.ladder(m, now, p, dp).quotes);
    return { quotes, center: (d.median() + dp.median()) / 2, reason: sidesReason(quotes), note: `${this.held}: quoting only what both reads allow` };
  }

  /** The quantile ladder for d, at b's margin: wider for thin sources, sources that disagree, and a stale read. */
  protected ladder(m: Market, now: number, b: Built, d: Dist): Target {
    const center = d.median();
    const notes: string[] = [];
    let margin = Math.max(b.thin ? this.sizing.thinMargin : this.sizing.ladder.margin, this.marginFloor);
    if (b.widen) {
      margin += b.widen.by;
      notes.push(b.widen.why);
    }
    if (now - this.readAt > STALE_MS) {
      margin += STALE_WIDEN;
      notes.push(`no fresh read for ${Math.round((now - this.readAt) / 60_000)} min${this.problem ? ` (${this.problem})` : ''}`);
    }
    const quotes = quantileLadder(d, strikesOf(m, now), { ...this.sizing.ladder, margin });
    return { quotes, center, reason: sidesReason(quotes), ...(notes.length && { note: `quoted ${Math.round(margin * 100)}% from 50/50: ${notes.join('; ')}` }) };
  }
}

/** Why a ladder has one side or none, if it does. */
function sidesReason(quotes: readonly Quote[]): string | undefined {
  const sides = new Set(quotes.map((q) => q.side));
  if (sides.size === 2) return undefined;
  return sides.has('up') ? 'no ask: Higher wins too often at every strike' : sides.has('down') ? 'no bid: Lower wins too often at every strike' : 'no strike is near 50/50';
}

/**
 * Two ladders for one book, merged to what's safe under both: the bids of the one whose best bid is lower, the
 * asks of the one whose best ask is higher. A side either ladder leaves out stays out.
 */
export function envelope(a: readonly Quote[], b: readonly Quote[]): Quote[] {
  const of = (qs: readonly Quote[], side: Quote['side']) => qs.filter((q) => q.side === side);
  const best = (qs: readonly Quote[], side: Quote['side']) => (side === 'up' ? Math.max(...qs.map((q) => q.strike)) : Math.min(...qs.map((q) => q.strike)));
  const pick = (side: Quote['side']): Quote[] => {
    const x = of(a, side);
    const y = of(b, side);
    if (!x.length || !y.length) return [];
    // a lower bid and a higher ask are the safer ones
    return side === 'up' ? (best(x, side) <= best(y, side) ? x : y) : best(x, side) >= best(y, side) ? x : y;
  };
  return [...pick('up'), ...pick('down')];
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

/** Another reading of the same number, set beside the fair value: a second venue, a related event, the tape. */
export interface Check {
  name: string;
  median: number;
}

/** The widening when any check is more than half the market's scale from the fair value, else none. */
export function disagreement(median: number, checks: readonly Check[], g: Guards | null): Built['widen'] {
  if (!g) return undefined;
  const far = checks.filter((c) => Math.abs(c.median - median) > g.scale / 2);
  if (!far.length) return undefined;
  return { by: DISAGREE_WIDEN, why: `${far.map((c) => `${c.name} says ${round(c.median)}`).join(', ')}, against ${round(median)}` };
}
