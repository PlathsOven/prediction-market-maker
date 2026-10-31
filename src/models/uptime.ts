// Uptime markets (CLAUDE-UP-1d/7d/30d, POLY-UP-1d/7d/30d): a fill settles on a component's uptime over the N whole
// UTC days before the first midnight at or after fill + N days, by the status page's own formula: downtime =
// major-outage time + 0.3 × partial-outage time, to two decimals. Nothing trades on it elsewhere, so the view is
// the component's own record: every N-day window of whole days in its history is one sample, recent windows
// weighing more (a window's weight halves every 30 days back: reliability changes, and on claude.ai's record the
// recent months forecast the published uptime of the next ones better than six equal months do). Windows with no outage are a point mass at 100%,
// which on most single days is most of the probability: a 1-day book is usually one-sided (bids only).
//
// The history is the status page's: claude.ai's Statuspage keeps every day back to 2023 (about six months are
// read), Polymarket's Instatus page its last 90 days. A fill's days start at the next UTC midnight, so an outage
// running now only counts if it lasts past it: while one runs the quotes widen, and in the last 2 hours before
// midnight the book comes down (the days ahead may start with it still running). After an outage earlier the same
// day the quotes widen, and so they do while the latest N whole days (the page's own record) sit more than half
// the market's scale from the fair value: outages cluster, and a run of them, or a clean spell after a bad one, is
// when the history is least sure.
import { Dist } from '../dist.ts';
import { type OutageDay, type Status, atlassianHistory, atlassianStatus, instatusHome, instatusStatus, outageDays } from '../sources/statuspage.ts';
import { type Built, DistModel, type Sizing, Unreadable, disagreement } from './model.ts';

export interface UptimeSpec {
  page: 'atlassian' | 'instatus';
  /** https://status.claude.com */
  base: string;
  component: string;
  /** The component's name, for logs. */
  name: string;
}

/** Statuspage history pages read (three months each). */
export const HISTORY_PAGES = 2;
/** A window's weight halves for every this many days back. */
export const HALF_LIFE_DAYS = 30;
/** Extra margin for the rest of a day that has already seen an outage. */
export const AFTER_OUTAGE_WIDEN = 0.02;
/** Extra margin while an outage runs... */
export const OUTAGE_WIDEN = 0.05;
/** ...and this close to the next UTC midnight (where a fill's days start) the book comes down instead. */
export const OUTAGE_PULL_MS = 2 * 3_600_000;

const DAY = 86_400_000;

/**
 * The uptime (%) of every n-day window of whole days, oldest first, leaving out `today` (still running), to two
 * decimals as the market settles: under 0.005% down (about 4 weighted seconds a day) is still 100.00%. Each comes
 * with the day it ends.
 */
export function windowUptimes(days: readonly OutageDay[], n: number, today: string): { end: string; u: number }[] {
  const done = days.filter((d) => d.day < today);
  const out: { end: string; u: number }[] = [];
  for (let i = 0; i + n <= done.length; i++) {
    const down = done.slice(i, i + n).reduce((t, d) => t + d.down, 0);
    out.push({ end: done[i + n - 1].day, u: Math.round(10_000 * (1 - down / (n * 86_400))) / 100 });
  }
  return out;
}

/** Samples' weights: halving every HALF_LIFE_DAYS from today back to each window's last day. */
export const recency = (end: string, today: string): number => 0.5 ** ((Date.parse(today) - Date.parse(end)) / DAY / HALF_LIFE_DAYS);

/**
 * Samples of uptime as a distribution (weights default to 1): a point mass at 100% for the clean windows, and the
 * weighted empirical CDF (linear between samples) for the rest.
 */
export function uptimeDist(samples: readonly { u: number; w?: number }[]): Dist {
  if (!samples.length) throw new Unreadable('no uptime history');
  const w = (s: { w?: number }) => s.w ?? 1;
  const total = samples.reduce((t, s) => t + w(s), 0);
  const clean = samples.filter((s) => s.u >= 100 - 1e-9).reduce((t, s) => t + w(s), 0) / total;
  const rest = samples.filter((s) => s.u < 100 - 1e-9).sort((a, b) => a.u - b.u);
  if (!rest.length) return new Dist([[100, 1]], []);
  const restTotal = rest.reduce((t, s) => t + w(s), 0);
  const knots: [number, number][] = [[rest[0].u - Math.max(0.01, (rest[rest.length - 1].u - rest[0].u) / rest.length), 0]];
  let run = 0;
  for (const s of rest) {
    run += w(s) / restTotal;
    if (knots[knots.length - 1][0] === s.u) knots[knots.length - 1][1] = run;
    else knots.push([s.u, run]);
  }
  return Dist.mix([
    [Dist.fromCdf(knots), 1 - clean],
    [new Dist([[100, 1]], []), clean],
  ]);
}

/** A status page's record of a component: its outage seconds by day (up to today), and its status now. */
export async function readPage(spec: UptimeSpec, now: number): Promise<{ days: OutageDay[]; status: Status }> {
  const { page, base, component } = spec;
  if (page === 'atlassian') {
    const [history, status] = await Promise.all([atlassianHistory(base, component, HISTORY_PAGES), atlassianStatus(base, component)]);
    return { days: history.days, status };
  }
  const [home, status] = await Promise.all([instatusHome(base, component), instatusStatus(base, component)]);
  return { days: outageDays(home.outages, home.from, Math.min(home.to, now)), status };
}

export class UptimeModel extends DistModel {
  readonly source: string;
  readonly pollMs = 60_000;
  /** A small sample: two points wider than the event markets' default. */
  protected marginFloor = 0.06;

  /** days: the market's horizon in whole days (1, 7 or 30). */
  constructor(
    private readonly spec: UptimeSpec,
    private readonly days: number,
    sizing: Sizing,
    private readonly read: (now: number) => Promise<{ days: OutageDay[]; status: Status }> = (now) => readPage(spec, now),
  ) {
    super(sizing);
    this.source = `${spec.base} (${spec.name}), ${days}-day windows`;
  }

  protected async build(now: number): Promise<Built> {
    const today = new Date(now).toISOString().slice(0, 10);
    const { days, status } = await this.read(now);
    const windows = windowUptimes(days, this.days, today);
    const samples = windows.map((s) => ({ u: s.u, w: recency(s.end, today) }));
    const dist = uptimeDist(samples);
    const latest = windows.at(-1);
    const clean = samples.filter((s) => s.u >= 100 - 1e-9).length;
    const downToday = days.find((d) => d.day === today)?.down ?? 0;
    return {
      dist,
      thin: false,
      reports: [
        {
          name: this.source,
          weight: 1,
          median: dist.median(),
          spread: 0,
          rows: [],
          note: `${samples.length} ${this.days}-day windows from ${days[0]?.day} · ${clean} without an outage · the latest (to ${latest?.end}) ${latest?.u}% · now ${status === 'up' ? 'up' : `in a ${status} outage`}${downToday ? ` · ${Math.round(downToday)} s down today` : ''}`,
        },
      ],
      ...(status !== 'up' && DAY - (now % DAY) <= OUTAGE_PULL_MS && { unsure: `${this.spec.name} is in a ${status} outage under 2 hours before midnight UTC` }),
      widen: this.widening(dist.median(), latest, downToday, status),
    };
  }

  /** The widening, if any: an outage now or earlier today, or the latest whole-day window far from the fair value. */
  private widening(median: number, latest: { end: string; u: number } | undefined, downToday: number, status: Status): Built['widen'] {
    const parts: NonNullable<Built['widen']>[] = [];
    const recent = latest ? disagreement(median, [{ name: `the ${this.days} days to ${latest.end}`, median: latest.u }], this.guards) : undefined;
    if (recent) parts.push(recent);
    if (status !== 'up') parts.push({ by: OUTAGE_WIDEN, why: `${this.spec.name} is in a ${status} outage now` });
    else if (downToday > 0) parts.push({ by: AFTER_OUTAGE_WIDEN, why: `${this.spec.name} had an outage earlier today` });
    if (!parts.length) return undefined;
    return { by: parts.reduce((t, w) => t + w.by, 0), why: parts.map((w) => w.why).join('; ') };
  }
}
