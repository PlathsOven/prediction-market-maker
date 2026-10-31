// The 10-year Treasury yield's daily closes: the US Treasury's Daily Par Yield Curve CSV ("10 Yr" column; the
// source the market settles on, posted the same evening, but slow to download), with FRED's DGS10 as the backup
// (fast, a business day behind). Both are public and keyless.
import { getText } from '../http.ts';

export interface Close {
  /** YYYY-MM-DD */
  day: string;
  value: number;
}

export const treasuryUrl = (year: number): string =>
  `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
export const fredUrl = (series: string, from: string): string => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${from}`;

const splitCsv = (line: string): string[] => line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));

/** Treasury's CSV (newest first, dates MM/DD/YYYY) as closes, oldest first. */
export function parseTreasuryCsv(text: string, column = '10 Yr'): Close[] {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const col = splitCsv(head).indexOf(column);
  if (col < 0) throw new Error(`no "${column}" column`);
  const out: Close[] = [];
  for (const row of rows) {
    const cells = splitCsv(row);
    const m = cells[0]?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const v = Number(cells[col]);
    if (m && cells[col] !== '' && Number.isFinite(v)) out.push({ day: `${m[3]}-${m[1]}-${m[2]}`, value: v });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/** FRED's graph CSV (observation_date,SERIES; "." where there's no value) as closes, oldest first. */
export function parseFredCsv(text: string): Close[] {
  const out: Close[] = [];
  for (const row of text.trim().split(/\r?\n/).slice(1)) {
    const [day, raw] = splitCsv(row);
    const v = Number(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') && raw !== '' && raw !== '.' && Number.isFinite(v)) out.push({ day, value: v });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/** This year's closes from Treasury (cached for 30 minutes: the file is big and changes once a day). */
export async function treasuryCloses(year: number): Promise<Close[]> {
  return parseTreasuryCsv(await getText(treasuryUrl(year), 30 * 60_000));
}

export async function fredCloses(series: string, from: string): Promise<Close[]> {
  return parseFredCsv(await getText(fredUrl(series, from), 10 * 60_000));
}

/** Two sources' closes as one series: Treasury's value wherever both have a day. */
export function mergeCloses(primary: readonly Close[], backup: readonly Close[]): Close[] {
  const by = new Map(backup.map((c) => [c.day, c.value]));
  for (const c of primary) by.set(c.day, c.value);
  return [...by.entries()].map(([day, value]) => ({ day, value })).sort((a, b) => a.day.localeCompare(b.day));
}
