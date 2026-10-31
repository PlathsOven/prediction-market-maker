// Strikes, Julian days and time zones.
//
// A market's strikes are offset + n × step (BTC: whole dollars; seats and posts: half units, so a count never
// lands on one; date markets: Julian Dates on .5, the midnights between days). Date markets carry a Julian Day
// Number (JDN): the Julian Date at noon UTC of that day. 2026-10-29 is JDN 2,461,343, and the strike
// 2,461,359.5 is 2026-11-15 00:00 UTC: Higher there wins if the event happens on Nov 15 or later.
import type { Market } from './api.ts';

export interface Grid {
  step: number;
  offset: number;
  /** The lowest and highest strikes the market takes (inclusive), when bounded. */
  min: number | null;
  max: number | null;
}

export const gridOf = (m: Market): Grid => ({
  step: m.strikeStep,
  offset: m.strikeOffset,
  min: m.strikeMin ?? null,
  max: m.strikeMax ?? null,
});

/** Rounds away float noise from grid arithmetic (0.1 + 0.2), so strikes compare exactly. */
export const clean = (x: number): number => Math.round(x * 1e9) / 1e9;

/** The nth strike. */
export const strikeAt = (g: Grid, n: number): number => clean(g.offset + n * g.step);

/** Where k sits on the grid, in steps (a whole number for a strike). */
export const indexOf = (g: Grid, k: number): number => (k - g.offset) / g.step;

/** The index of the lowest strike the market takes, or null when unbounded below. */
export const minIndex = (g: Grid): number | null => (g.min === null ? null : Math.ceil(indexOf(g, g.min) - 1e-9));
/** The index of the highest strike the market takes, or null when unbounded above. */
export const maxIndex = (g: Grid): number | null => (g.max === null ? null : Math.floor(indexOf(g, g.max) + 1e-9));

// ---- Julian days --------------------------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
/** The Julian Date at the Unix epoch, 1970-01-01 00:00 UTC. */
const JD_EPOCH = 2_440_587.5;

/** The Julian Date of a moment: x.5 is a UTC midnight. */
export const jdOf = (ms: number): number => ms / DAY_MS + JD_EPOCH;
/** The moment of a Julian Date. */
export const msOfJd = (jd: number): number => Math.round((jd - JD_EPOCH) * DAY_MS);
/** The JDN of the UTC day ms falls in. */
export const jdnOf = (ms: number): number => Math.floor(ms / DAY_MS) + JD_EPOCH + 0.5;
/** The JDN of a calendar day (month 1-12). */
export const jdnOfDay = (y: number, month: number, d: number): number => jdnOf(Date.UTC(y, month - 1, d));
/** The calendar day a JDN names, as YYYY-MM-DD. */
export const dayOfJdn = (jdn: number): string => new Date(msOfJd(Math.round(jdn) - 0.5)).toISOString().slice(0, 10);

// ---- time zones ---------------------------------------------------------------------------------------------

const zones = new Map<string, Intl.DateTimeFormat>();

/** A zone's offset from UTC at a moment, in hours (America/New_York: -4 in summer, -5 in winter; Asia/Tehran: 3.5). */
export function tzOffsetHours(ms: number, zone: string): number {
  if (zone === 'UTC') return 0;
  let f = zones.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zones.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((local - Math.floor(ms / 1000) * 1000) / 60_000) / 60;
}

/** The moment a zone's calendar day ends (its next midnight), for the day with this JDN. */
export function endOfDayIn(jdn: number, zone: string): number {
  const utcMidnight = msOfJd(jdn + 0.5);
  // the offset just before that midnight (a DST change at 2 AM never moves a midnight's own offset)
  return utcMidnight - tzOffsetHours(utcMidnight - 3_600_000, zone) * 3_600_000;
}

/**
 * Where a moment sits on a date market's axis: its Julian Date on the market's own clock. The market's value
 * is the calendar day (in `zone`) the event happens on, so an event at moment t has value round(axis(t)), and
 * Lower at strike k wins iff axis(t) < k.
 */
export const axisOf = (ms: number, zone: string): number => jdOf(ms) + tzOffsetHours(ms, zone) / 24;
