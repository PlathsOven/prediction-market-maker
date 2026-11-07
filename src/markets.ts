// Which model quotes which market, and where each looks. Keyed by the underlying's public id (GET /markets
// `underlying`), so every market on an underlying (BTC-15s, BTC-1m, BTC-5m; ELON-1d, ELON-7d) shares an entry.
//
// Bucket edges are written out here rather than guessed from the labels: [lo, hi] are the values a bucket holds
// (whole numbers and levels inclusive, continuous numbers [lo, hi)), null for an open end. A label that isn't
// listed is parsed from its text, and one that can't be read stops the market (rather than misplace its mass).
// `offline` is the market as the exchange lists it, for `bun src/read.ts` before it's listed; once the exchange
// lists a market, its own grid, bounds and dates are used.
import type { Market } from './api.ts';
import type { AnalogSpec } from './analogs.ts';
import type { ValueType } from './buckets.ts';
import { Dist, normalKnots } from './dist.ts';
import { BTC_FEED, type FeedCalibration, GOLD_SIGMA, type SigmaCalibration, feedLadder, sigmaLadder } from './ladder.ts';
import { type DateSource, type DayBuckets, DateModel } from './models/date.ts';
import { ElonModel, HISTORY_DAYS } from './models/elon.ts';
import { EventModel, type Prior } from './models/event.ts';
import { FeedModel } from './models/feed.ts';
import { type Built, DistModel, type Guards, type Model, type Sizing } from './models/model.ts';
import { MaxYieldModel } from './models/ust10y.ts';
import { UptimeModel, type UptimeSpec } from './models/uptime.ts';
import { USD_BILLIONS } from './sources/polymarket.ts';
import { PostLog } from './sources/xtracker.ts';

export type Spec =
  /** A price feed, quoted with BTC's ladder in strikes. */
  | { model: 'feed'; calibration: FeedCalibration }
  /** A price feed, quoted with BTC's ladder in sigmas (gold's strikes are coarse next to its moves). */
  | { model: 'sigmaFeed'; calibration: SigmaCalibration; maxAgeMs?: number }
  /** A running count (Elon's posts): the count now plus the posts over the horizon, from the post history. */
  | { model: 'elon' }
  | { model: 'event'; value: ValueType; support: [number, number]; sources: AnalogSpec[]; checks?: AnalogSpec[]; drop?: RegExp[]; conditional?: boolean; prior?: Prior }
  | { model: 'date'; zone: string; sources: DateSource[]; checks?: DayBuckets[] }
  | { model: 'maxYield'; slug: string; from: string; to: string; cap: number }
  | { model: 'uptime'; uptime: UptimeSpec }
  /** No usable analog: a distribution written here (CDF knots [x, P(X ≤ x)]), always quoted wider. */
  | { model: 'prior'; knots: [number, number][]; why: string };

export type Listing = Partial<Market> & { id: string };

export interface Entry {
  spec: Spec;
  /** The fair value's checks, in the market's units (src/models/model.ts); per market when its horizons differ. */
  guards?: Guards | ((m: Pick<Market, 'horizon'>) => Guards);
  /** The best quotes' margin, over the default (src/ladder.ts LADDER). */
  margin?: number;
  offline?: Listing | Listing[];
}

/** A market's guards, from its entry. */
export const guardsOf = (e: Entry, m: Pick<Market, 'horizon'>): Guards | null => (typeof e.guards === 'function' ? e.guards(m) : (e.guards ?? null));

const ms = (iso: string) => Date.parse(iso);
/** An uptime's three underlyings (API ids <prefix>-1D, -7D, -30D), one market each (<market>-1d, -7d, -30d). */
function uptimeEntries(prefix: string, market: string, uptime: UptimeSpec, scale: number): Record<string, Entry> {
  return Object.fromEntries(
    [1, 7, 30].map((d): [string, Entry] => [
      `${prefix}-${d}D`,
      {
        guards: { scale, sane: [90, 100] },
        spec: { model: 'uptime', uptime },
        offline: { id: `${market}-${d}d`, kind: 'rolling', horizon: d * 86_400, unit: 'uptime', strikeStep: 0.01, strikeOffset: 0.005, strikeMin: 0.005, strikeMax: 99.995 },
      },
    ]),
  );
}

/** One standard deviation of an NFL game's total, or of its margin, against the line, in points. */
const NFL_SIGMA = 13.5;
/**
 * A book one point wide leaves a taker with 3¢ per $1 to pay at that sigma (0.8 × half-spread ÷ sigma), against 4.5¢ for
 * a sportsbook's -110: this margin keeps the best quotes on the half-points either side of the median.
 */
const NFL_MARGIN = 0.015;

/**
 * An NFL game's two books, off Polymarket's and Kalshi's ladders (each a threshold every point or two, trading through
 * the game), half each. Polymarket lists a game's moneyline weeks ahead and its totals and spreads about two weeks
 * out, but quotes them within 10¢ only in the last week, the moneyline first; Kalshi lists about a week out. While
 * Polymarket quotes only a line or two, they're read as a normal through them (NFL_SIGMA wide); with nothing quoted
 * anywhere, and only until kickoff, the prior. Both are quoted wider.
 *
 * api: NFL-CHI-DET (Polymarket's slug is this, lowercase, and the kickoff's UTC date); game: Kalshi's 26NOV26CHIDET;
 * home: the home team as Kalshi (DET) and Polymarket (Lions) name it.
 */
function nflEntries(
  api: string,
  game: string,
  home: { code: string; name: string },
  kickoff: string,
  prior: { total: number; margin: number; why: string },
): Record<string, Entry> {
  const until = ms(kickoff);
  const slug = `${api.toLowerCase()}-${kickoff.slice(0, 10)}`;
  const book = (line: 'TOTAL' | 'SPREAD', mean: number, unit: string, support: [number, number], strikes: [number, number]): [string, Entry] => [
    `${api}-${line}`,
    {
      margin: NFL_MARGIN,
      guards: { scale: 7, sane: support },
      spec: {
        model: 'event',
        value: { type: 'continuous' },
        support,
        sources: [
          line === 'TOTAL' ? { venue: 'polymarket', slug, shape: 'total', sigma: NFL_SIGMA } : { venue: 'polymarket', slug, shape: 'margin', home: home.name, sigma: NFL_SIGMA },
          { venue: 'kalshi', event: `KXNFL${line}-${game}`, ...(line === 'SPREAD' && { home: home.code }) },
        ],
        prior: { knots: normalKnots(mean, NFL_SIGMA), why: prior.why, until },
      },
      offline: { id: `${api}-${line}`, kind: 'fixed', unit, strikeStep: 1, strikeOffset: 0.5, strikeMin: strikes[0], strikeMax: strikes[1], expiresAt: until + 8 * 3_600_000 },
    },
  ];
  return Object.fromEntries([book('TOTAL', prior.total, 'points', [0, 120], [0, 150]), book('SPREAD', prior.margin, 'spread', [-70, 70], [-100, 100])]);
}

export const CATALOG: Readonly<Record<string, Entry>> = {
  'BTC-USD': { spec: { model: 'feed', calibration: BTC_FEED } },
  'PAXG-USD': {
    // the exchange takes no gold orders without an index tick in the last 5 s: the book is held from a second before
    spec: { model: 'sigmaFeed', calibration: GOLD_SIGMA, maxAgeMs: 4_000 },
    offline: { id: 'GOLD-15s', underlying: 'PAXG-USD', kind: 'rolling', horizon: 15, unit: 'usd', strikeStep: 0.1, strikeOffset: 0 },
  },
  // Elon Musk's posts on X since 2026-01-01 (XTracker's count): the count now plus the posts over the next 1 or 7
  // days; the guards are on those posts to come
  'ELON-POSTS': {
    guards: (m) => ((m.horizon ?? 0) <= 86_400 ? { scale: 10, sane: [1, 400] } : { scale: 50, sane: [5, 2500] }),
    spec: { model: 'elon' },
    offline: [
      { id: 'ELON-1d', kind: 'rolling', horizon: 86_400, unit: 'count', strikeStep: 1, strikeOffset: 0.5 },
      { id: 'ELON-7d', kind: 'rolling', horizon: 604_800, unit: 'count', strikeStep: 1, strikeOffset: 0.5 },
    ],
  },

  // Thanksgiving's three games. The priors' margins are ESPN's matchup predictor on Nov 4 (the home team's chance of
  // winning, at NFL_SIGMA); the totals are a typical game's
  ...nflEntries('NFL-CHI-DET', '26NOV26CHIDET', { code: 'DET', name: 'Lions' }, '2026-11-26T18:00:00Z', { total: 46, margin: -2, why: 'a typical total; ESPN gives the Lions 44%' }),
  ...nflEntries('NFL-PHI-DAL', '26NOV26PHIDAL', { code: 'DAL', name: 'Cowboys' }, '2026-11-26T21:30:00Z', { total: 46, margin: 12, why: 'a typical total; ESPN gives the Cowboys 81%' }),
  ...nflEntries('NFL-KC-BUF', '26NOV26KCBUF', { code: 'BUF', name: 'Bills' }, '2026-11-27T01:20:00Z', { total: 46, margin: 3, why: 'a typical total; ESPN gives the Bills 60%' }),

  'HOUSE-R-2026': {
    guards: { scale: 8, sane: [150, 290] },
    spec: {
      model: 'event',
      value: { type: 'integer' },
      // the floor rose with the calls: open-ended low buckets spread evenly down to it (Nov 5, 2026: about 153 seats called, 33 open)
      support: [165, 260],
      sources: [
        {
          venue: 'polymarket',
          slug: 'republican-house-seats-after-the-2026-midterm-elections',
          weight: 0.4,
          edges: {
            'Below 190': [null, 189],
            '190-194': [190, 194],
            '195-199': [195, 199],
            '200-204': [200, 204],
            '205-209': [205, 209],
            '210-214': [210, 214],
            '215-219': [215, 219],
            '220-224': [220, 224],
            '225-229': [225, 229],
            '230+': [230, null],
          },
          refine: {
            slug: 'republican-house-seats-after-the-2026-midterm-elections-lower-brackets',
            bucket: 'Below 190',
            edges: {
              'Below 170': [null, 169],
              '170-174': [170, 174],
              '175-179': [175, 179],
              '180-184': [180, 184],
              '185-189': [185, 189],
              '190+': [190, null],
            },
          },
        },
        // Kalshi's seat markets are the deeper books (each bracket trades $0.3-2M)
        { venue: 'kalshi', event: 'KXRHOUSESEATS-27', weight: 0.35 },
        { venue: 'kalshi', event: 'KXDHOUSESEATS-27', weight: 0.25, mirror: 435 },
      ],
    },
    offline: { id: 'HOUSE-R-2026', kind: 'fixed', unit: 'seats', strikeStep: 1, strikeOffset: 0.5, strikeMin: 0, strikeMax: 435, expiresAt: ms('2027-01-05T04:59:00Z') },
  },

  'SENATE-R-2026': {
    guards: { scale: 1.5, sane: [35, 70] },
    spec: {
      model: 'event',
      value: { type: 'integer' },
      // Republicans have 44 seats called (Nov 5, 2026), so "below 45" means 44, not an even spread down to the old floor of 35; a floor at 44 itself would leave no bid
      support: [43, 65],
      sources: [
        {
          venue: 'polymarket',
          slug: 'republican-senate-seats-after-the-2026-midterm-elections-927',
          weight: 0.4,
          edges: {
            '≤47': [null, 47],
            '48': [48, 48],
            '49': [49, 49],
            '50': [50, 50],
            '51': [51, 51],
            '52': [52, 52],
            '53': [53, 53],
            '54': [54, 54],
            '55': [55, 55],
            '56': [56, 56],
            '57+': [57, null],
          },
          refine: {
            slug: 'republican-senate-seats-after-the-midterms-low-brackets',
            bucket: '≤47',
            edges: {
              '≤40': [null, 40],
              '41': [41, 41],
              '42': [42, 42],
              '43': [43, 43],
              '44': [44, 44],
              '45': [45, 45],
              '46': [46, 46],
              '47': [47, 47],
              '48+': [48, null],
            },
          },
        },
        { venue: 'kalshi', event: 'RSENATESEATS-27', weight: 0.35 },
        { venue: 'kalshi', event: 'KXDSENATESEATS-27', weight: 0.25, mirror: 100 },
      ],
    },
    offline: { id: 'SENATE-R-2026', kind: 'fixed', unit: 'seats', strikeStep: 1, strikeOffset: 0.5, strikeMin: 0, strikeMax: 100, expiresAt: ms('2027-01-05T04:59:00Z') },
  },

  'HOUSE-VOTE-2026': {
    guards: { scale: 1.5, sane: [-20, 30] },
    spec: {
      model: 'event',
      value: { type: 'continuous' },
      support: [-15, 25],
      sources: [
        {
          venue: 'polymarket',
          slug: '2026-midterms-house-popular-vote-margin-of-victory-224',
          weight: 0.5,
          // our number is Democratic minus Republican, in points: a Republican bucket is negative
          edges: {
            'Democrats 16%+': [16, null],
            'Democrats 14-16%': [14, 16],
            'Democrats 12-14%': [12, 14],
            'Democrats 10-12%': [10, 12],
            'Democrats 8-10%': [8, 10],
            'Democrats 6-8%': [6, 8],
            'Democrats 4-6%': [4, 6],
            'Democrats 2-4%': [2, 4],
            'Democrats 0-2%': [0, 2],
            'Republicans 0-2%': [-2, 0],
            'Republicans 2-4%': [-4, -2],
            'Republicans 4-6%': [-6, -4],
            'Republicans 6%+': [null, -6],
          },
          labels: { signs: { Democrats: 1, Republicans: -1 } },
        },
        { venue: 'kalshi', event: 'KXHOUSEPOPVOTEMARGIN-27NOV03', weight: 0.5 },
      ],
    },
    offline: { id: 'HOUSE-VOTE-2026', kind: 'fixed', unit: 'margin', strikeStep: 0.1, strikeOffset: 0.05, strikeMin: -100, strikeMax: 100, expiresAt: ms('2027-07-01T03:59:00Z') },
  },

  'IRAN-STRIKE': {
    guards: { scale: 10 },
    spec: {
      model: 'date',
      zone: 'UTC',
      // "the ceasefire continues through Nov 15": no qualifying strike by 11:59 PM Iran time that day
      sources: [{ venue: 'polymarket', slug: 'us-iran-ceasefire-continues-throughptptpt', shape: 'survival', zone: 'Asia/Tehran' }],
    },
    offline: { id: 'IRAN-STRIKE', kind: 'date', unit: 'date', strikeStep: 1, strikeOffset: 0.5, deadline: ms('2026-12-31T12:00:00Z') },
  },

  'ANTH-IPO-DATE': {
    guards: { scale: 5 },
    spec: {
      model: 'date',
      zone: 'America/New_York',
      sources: [{ venue: 'polymarket', slug: 'anthropic-ipo-by', shape: 'cumulative', zone: 'America/New_York' }],
      // the same question as day buckets ("IPO on Nov 18?"): a check, not mixed in
      checks: [{ venue: 'polymarket', slug: 'anthropic-ipo-date', shape: 'days', zone: 'America/New_York' }],
    },
    offline: { id: 'ANTH-IPO-DATE', kind: 'date', unit: 'date', strikeStep: 1, strikeOffset: 0.5, deadline: ms('2026-12-31T12:00:00Z') },
  },

  'ANTH-IPO-CAP': {
    guards: { scale: 200, sane: [500, 6000] },
    spec: {
      model: 'event',
      value: { type: 'continuous' },
      support: [1000, 3500],
      // void if there's no IPO: that bucket goes, and the rest is the market cap given an IPO
      drop: [/^no ipo/i],
      sources: [
        {
          venue: 'polymarket',
          slug: 'anthropic-ipo-closing-market-cap-higher-strikes',
          edges: {
            '<$1.25T': [null, 1250],
            '$1.25–$1.5T': [1250, 1500],
            '$1.5–$1.75T': [1500, 1750],
            '$1.75–$2.0T': [1750, 2000],
            '$2.0–$2.25T': [2000, 2250],
            '$2.25–$2.5T': [2250, 2500],
            '$2.5–$2.75T': [2500, 2750],
            '$2.75–$3.0T': [2750, 3000],
            '$3.0T+': [3000, null],
          },
          labels: { scale: USD_BILLIONS },
        },
      ],
      // the same question as a ladder ("closing market cap above $2T?"), a separate book: a check, not mixed in
      checks: [{ venue: 'polymarket', slug: 'anthropic-ipo-closing-market-cap-above', shape: 'survival', labels: { scale: USD_BILLIONS } }],
    },
    offline: { id: 'ANTH-IPO-CAP', kind: 'fixed', unit: 'usdbn', strikeStep: 10, strikeOffset: 0, strikeMin: 10, expiresAt: ms('2028-01-01T04:59:00Z') },
  },

  'FABLE-NEXT': {
    guards: { scale: 10 },
    spec: {
      model: 'date',
      zone: 'America/New_York',
      sources: [{ venue: 'polymarket', slug: 'next-fable-model-5pt2-released-byptptpt', shape: 'cumulative', zone: 'America/New_York' }],
    },
    offline: { id: 'FABLE-NEXT', kind: 'date', unit: 'date', strikeStep: 1, strikeOffset: 0.5, deadline: ms('2026-12-31T12:00:00Z') },
  },

  'FED-2027': {
    guards: { scale: 0.5, sane: [0.5, 10] },
    spec: {
      model: 'event',
      value: { type: 'levels', step: 0.25 },
      support: [1.5, 7],
      sources: [
        {
          venue: 'polymarket',
          slug: 'what-will-the-fed-rate-be-at-the-end-of-2027',
          weight: 0.6,
          edges: {
            '≤2.5%': [null, 2.5],
            '2.75%': [2.75, 2.75],
            '3.0%': [3, 3],
            '3.25%': [3.25, 3.25],
            '3.5%': [3.5, 3.5],
            '3.75%': [3.75, 3.75],
            '4.0%': [4, 4],
            '4.25%': [4.25, 4.25],
            '4.5%': [4.5, 4.5],
            '4.75%': [4.75, 4.75],
            '5.0%': [5, 5],
            '5.25%': [5.25, 5.25],
            '5.5%': [5.5, 5.5],
            '5.75%': [5.75, 5.75],
            '≥6.0%': [6, null],
          },
        },
        // "above x%" thresholds; on 2026-10-29 every one was quoted over 10¢ wide, so it reads as unusable until it fills in
        { venue: 'kalshi', event: 'KXFED-27DEC', weight: 0.4 },
      ],
    },
    offline: { id: 'FED-2027', kind: 'fixed', unit: 'pct', strikeStep: 0.25, strikeOffset: 0.125, strikeMin: 0, strikeMax: 20, expiresAt: ms('2028-01-01T04:59:00Z') },
  },

  'UST10Y-MAX-2026': {
    guards: { scale: 0.1, sane: [3, 8] },
    spec: { model: 'maxYield', slug: 'how-high-will-10-year-treasury-yield-go-before-2027', from: '2026-10-29', to: '2026-12-31', cap: 7.5 },
    offline: { id: 'UST10Y-MAX-2026', kind: 'fixed', unit: 'pct', strikeStep: 0.01, strikeOffset: 0.005, strikeMin: 0, strikeMax: 20, expiresAt: ms('2026-12-31T21:00:00Z') },
  },

  'PREDICT-FDV': {
    guards: { scale: 0.3, sane: [0.05, 20] },
    spec: {
      model: 'event',
      value: { type: 'continuous' },
      support: [0, 6],
      // void if no token launches: read the "FDV above" ladder as conditional on a launch
      conditional: true,
      sources: [{ venue: 'polymarket', slug: 'predictfun-fdv-above-one-day-after-launch', shape: 'survival', labels: { scale: USD_BILLIONS } }],
    },
    offline: { id: 'PREDICT-FDV', kind: 'fixed', unit: 'usdbn', strikeStep: 0.01, strikeOffset: 0, strikeMin: 0.01, expiresAt: ms('2028-01-01T04:59:00Z') },
  },

  // one underlying per horizon (CLAUDE-UPTIME-1D, -7D, -30D), each settling on that many whole UTC days
  ...uptimeEntries('CLAUDE-UPTIME', 'CLAUDE-UP', { page: 'atlassian', base: 'https://status.claude.com', component: 'rwppv331jlwc', name: 'claude.ai' }, 0.15),
  ...uptimeEntries(
    'POLYMARKET-UPTIME',
    'POLY-UP',
    { page: 'instatus', base: 'https://status.polymarket.com', component: 'cljg99p53207029broc36bdpn0h', name: 'Polymarket Predictions Trading API (CLOB)' },
    0.3,
  ),
};

/** A market with no analog: the distribution written in its entry, quoted three points wider than the default. */
export class PriorModel extends DistModel {
  readonly source: string;
  protected marginFloor = 0.07;

  constructor(
    private readonly knots: [number, number][],
    why: string,
    sizing: Sizing,
  ) {
    super(sizing);
    this.source = `prior: ${why}`;
  }

  protected async build(): Promise<Built> {
    const dist = Dist.fromCdf(this.knots);
    return { dist, thin: true, reports: [{ name: this.source, weight: 1, median: dist.median(), spread: 0, rows: [] }] };
  }
}

export interface Deps {
  sizing: Sizing;
  /** Feed markets' size a level and levels a side, over each calibration's own. */
  feed?: { size?: number; levels?: number };
  /** Quote a number that isn't live (src/config.ts quoteNotLive). */
  quoteNotLive?: boolean;
  /** The market's latest listing (date models read their deadline from it). */
  listing: () => Market;
}

/** The model for a market, or null when the bots have none for its underlying. */
export function createModel(m: Market, deps: Deps): Model | null {
  const entry = CATALOG[m.underlying];
  if (!entry) return null;
  const sizing = entry.margin === undefined ? deps.sizing : { ...deps.sizing, ladder: { ...deps.sizing.ladder, margin: entry.margin } };
  const model = modelOf(entry, m, { ...deps, sizing });
  if (model instanceof DistModel) model.guards = guardsOf(entry, m);
  return model;
}

/** Elon's post history, read once for both his books. */
let elonLog: PostLog | null = null;

/** The markets an entry lists for reading before the exchange lists them. */
export const offlineListings = (e: Entry): Listing[] => (e.offline === undefined ? [] : Array.isArray(e.offline) ? e.offline : [e.offline]);

function modelOf(entry: Entry, m: Market, deps: Deps): Model | null {
  const s = entry.spec;
  switch (s.model) {
    case 'feed': {
      const cal = { ...s.calibration, ...deps.feed };
      return new FeedModel((spot, sigma, h, g) => feedLadder(spot, sigma, h, g, cal), !!deps.quoteNotLive, `${m.underlying} price (Rizon's feed)`);
    }
    case 'sigmaFeed': {
      const cal = { ...s.calibration, ...deps.feed };
      return new FeedModel((spot, sigma, h, g) => sigmaLadder(spot, sigma, h, g, cal), !!deps.quoteNotLive, `${m.underlying} price (Rizon's feed)`, s.maxAgeMs);
    }
    case 'elon':
      // a horizon of whole days: 1 or 7
      return new ElonModel(Math.max(1, Math.round((m.horizon ?? 86_400) / 86_400)), (elonLog ??= new PostLog('elonmusk', HISTORY_DAYS)), deps.sizing, undefined, !!deps.quoteNotLive);
    case 'event':
      return new EventModel(s.sources, { value: s.value, support: s.support, drop: s.drop, conditional: s.conditional }, deps.sizing, s.checks, s.prior);
    case 'date':
      return new DateModel(s.sources, s.zone, () => deps.listing().deadline ?? offlineListings(entry)[0]?.deadline ?? NaN, deps.sizing, s.checks);
    case 'maxYield':
      return new MaxYieldModel(s.slug, { from: s.from, to: s.to, cap: s.cap }, deps.sizing);
    case 'uptime':
      // a horizon of whole days: 1, 7 or 30
      return new UptimeModel(s.uptime, Math.max(1, Math.round((m.horizon ?? 604_800) / 86_400)), deps.sizing);
    case 'prior':
      return new PriorModel(s.knots, s.why, deps.sizing);
  }
}
