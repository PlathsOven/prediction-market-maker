// Polymarket, read through its public Gamma API (no key): GET /events?slug=<slug> returns the event with every
// market in it, each with the Yes token's best bid, best ask and last trade. Those are the CLOB's own best
// prices (checked against POST clob.polymarket.com/books on 2026-10-29), so one request per event per poll is
// all a bot needs. Docs: https://docs.polymarket.com
import { getJson } from '../http.ts';

export const GAMMA = 'https://gamma-api.polymarket.com';

export interface PmMarket {
  /** groupItemTitle: the bucket's label ("195-199", "Below 190", "November 15", "$1.5B"). */
  label: string;
  /** The Yes token's best bid and ask, and its last trade (0-1); null when absent. */
  bid: number | null;
  ask: number | null;
  last: number | null;
  active: boolean;
  /** Resolved (or closed for trading): its price is no longer a forecast. */
  closed: boolean;
  /** When the market ends (on dated ladders, about the date's cutoff). */
  endDate: string | null;
  /** "Spread: Lions (-6.5)": a game's markets share a groupItemTitle per line, so this is what tells them apart. */
  question: string;
  /** A game's market: moneyline, spreads, totals, … (sportsMarketType); null elsewhere. */
  type: string | null;
  /** A game's line, for the first outcome: −6.5 is that team by 7 or more; 50.5 is the total over 50.5. */
  line: number | null;
  /** The outcomes, the first being the one bid and ask are for: ["Yes", "No"], ["Lions", "Dolphins"], ["Over", "Under"]. */
  outcomes: string[];
  /** The first outcome's CLOB token, which its quotes stream on (src/sources/polymarket-live.ts). */
  token: string | null;
}

export interface PmEvent {
  slug: string;
  markets: PmMarket[];
}

/** A venue's number, sent as a number or a numeric string; null when it's neither. */
export const num = (x: unknown): number | null => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** A list sent as a JSON string ('["Over", "Under"]') or an array: the outcomes, their tokens. */
function listOf(x: unknown): string[] {
  let v = x;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.map(String) : [];
}

/** One event from GET /events?slug= (an array) or GET /events/slug/<slug> (the object). */
export function parsePmEvent(json: unknown): PmEvent {
  const ev = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
  if (!ev || !Array.isArray(ev.markets)) throw new Error('no such Polymarket event');
  return {
    slug: String(ev.slug ?? ''),
    markets: (ev.markets as Record<string, unknown>[]).map((m) => ({
      label: String(m.groupItemTitle ?? m.question ?? '').trim(),
      bid: num(m.bestBid),
      ask: num(m.bestAsk),
      last: num(m.lastTradePrice),
      active: m.active !== false,
      closed: m.closed === true,
      endDate: typeof m.endDate === 'string' ? m.endDate : null,
      question: String(m.question ?? ''),
      type: typeof m.sportsMarketType === 'string' ? m.sportsMarketType : null,
      line: num(m.line),
      outcomes: listOf(m.outcomes),
      token: listOf(m.clobTokenIds)[0] ?? null,
    })),
  };
}

export async function pmEvent(slug: string): Promise<PmEvent> {
  return parsePmEvent(await getJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`));
}

/** The markets still trading: open, active, not resolved. */
export const tradingMarkets = (ev: PmEvent): PmMarket[] => ev.markets.filter((m) => m.active && !m.closed);

/**
 * The event as its tape prices it: each market at its last trade (bid and ask both), the ones that never traded
 * left out. A check on the quotes: the same views read at the last trades should land close to the mids.
 */
export const atLastTrades = (ev: PmEvent): PmEvent => ({
  ...ev,
  markets: ev.markets.flatMap((m) => (m.last === null ? (m.closed || !m.active ? [m] : []) : [{ ...m, bid: m.last, ask: m.last }])),
});

// ---- labels -------------------------------------------------------------------------------------------------

/**
 * What a bucket's label says about the number, before it's placed on the number line (that depends on whether
 * the number is whole: see buckets.ts). a and b are in the market's units.
 *   range   a to b ("195-199", "$1.25–$1.5T", "Democrats 14-16%")
 *   below   under a ("Below 190", "<$1.25T", "<20")      atMost  a or under ("≤47", "47 or fewer")
 *   atLeast a or over ("230+", "≥6.0%", "580+")          above   over a ("Above 249", "more than 5")
 *   exact   a ("48", "4.25%", "$1.5B")
 */
export type Range =
  | { kind: 'range'; a: number; b: number }
  | { kind: 'below' | 'atMost' | 'atLeast' | 'above' | 'exact'; a: number };

export interface LabelOptions {
  /** Multipliers for suffixes, into the market's units (usdbn: T → 1000, B → 1, M → 0.001). */
  scale?: Readonly<Record<string, number>>;
  /** Words that mark a side of a signed number ("Republicans" → −1 on a Democratic margin). */
  signs?: Readonly<Record<string, 1 | -1>>;
}

export const USD_BILLIONS: Readonly<Record<string, number>> = { t: 1000, b: 1, m: 0.001, k: 0.000001 };

type One = Exclude<Range['kind'], 'range'>;
/** −x, without a −0 ("Republicans 0-2%" ends at 0). */
const neg = (x: number): number => 0 - x;
const FLIP: Record<One, One> = { below: 'above', atMost: 'atLeast', atLeast: 'atMost', above: 'below', exact: 'exact' };

/** A numeric bucket label as a Range, or null when it doesn't read as one ("Other", "No IPO by …"). */
export function parseLabel(label: string, o: LabelOptions = {}): Range | null {
  let s = label.normalize('NFKC').toLowerCase().replace(/[–—]/g, '-').replace(/−/g, '-').replace(/,/g, '').trim();
  let sign: 1 | -1 = 1;
  for (const [word, sg] of Object.entries(o.signs ?? {})) {
    if (s.startsWith(word.toLowerCase())) {
      sign = sg;
      s = s.slice(word.length).trim();
      break;
    }
  }
  let kind: One | null = null;
  const pre: [RegExp, One][] = [
    [/^(<=|≤|at most|up to)\s*/, 'atMost'],
    [/^(<|below|under|less than|fewer than)\s*/, 'below'],
    [/^(>=|≥|at least)\s*/, 'atLeast'],
    [/^(>|above|over|more than|greater than)\s*/, 'above'],
  ];
  for (const [re, k] of pre) {
    if (re.test(s)) {
      kind = k;
      s = s.replace(re, '');
      break;
    }
  }
  const post: [RegExp, One][] = [
    [/\s*(\+|or more|or above|and above|or higher|or greater)$/, 'atLeast'],
    [/\s*(or fewer|or less|or below|or lower)$/, 'atMost'],
  ];
  for (const [re, k] of post) {
    if (re.test(s)) {
      kind = k;
      s = s.replace(re, '');
      break;
    }
  }
  // numbers, each with an optional suffix ($1.25-$1.5T: the T applies to both); a lone "-" between two numbers is a dash
  const nums = [...s.matchAll(/(?:^|[\s$(-])(-?\d+(?:\.\d+)?)\s*([tbmk%])?/g)];
  if (!nums.length || nums.length > 2) return null;
  const rest = s.replace(/(?:^|[\s$(-])-?\d+(?:\.\d+)?\s*[tbmk%]?/g, '').replace(/[\s$%()-]|seats?|posts?|tweets?|bps?|pts?/g, '');
  if (rest) return null; // words we don't understand
  const lastSuffix = nums[nums.length - 1][2];
  const values = nums.map((m) => {
    const suffix = (m[2] ?? lastSuffix ?? '').toLowerCase();
    const scale = suffix && suffix !== '%' ? (o.scale?.[suffix] ?? null) : 1;
    return scale === null ? NaN : Number(m[1]) * scale;
  });
  if (values.some((v) => !Number.isFinite(v))) return null;
  // "0-19": the dash between two numbers was taken as a separator above, so the second is never negative
  if (values.length === 2) {
    if (kind !== null) return null;
    const r: Range = { kind: 'range', a: Math.min(...values), b: Math.max(...values) };
    return sign === 1 ? r : { kind: 'range', a: neg(r.b), b: neg(r.a) };
  }
  const a = values[0];
  const k = kind ?? 'exact';
  return sign === 1 ? { kind: k, a } : { kind: FLIP[k], a: neg(a) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A dated market's day: "November 15", "Nov 15", "December 31, 2026". A label without a year takes the year
 * of the market's end (its cutoff, which can fall early the next day in UTC: a few hours are taken off first).
 */
export function parseDateLabel(label: string, endDate: string | null): { y: number; m: number; d: number } | null {
  const s = label.toLowerCase().replace(/,/g, ' ');
  const mm = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:\s+(\d{4}))?\b/);
  if (!mm) return null;
  const m = MONTHS.indexOf(mm[1]) + 1;
  const d = Number(mm[2]);
  let y = mm[3] ? Number(mm[3]) : NaN;
  if (!Number.isFinite(y)) {
    const end = endDate ? Date.parse(endDate) : NaN;
    if (!Number.isFinite(end)) return null;
    y = new Date(end - 12 * 3_600_000).getUTCFullYear();
  }
  if (d < 1 || d > 31) return null;
  return { y, m, d };
}
