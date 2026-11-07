// The fair value's guards (sane range, a jump waiting for a second read, widening, staleness), the feeds' hold,
// the uptime horizons and outages, and the day-bucket check, on recorded responses where there are any.
import { describe, expect, test } from 'bun:test';
import type { Market } from '../src/api.ts';
import { Dist } from '../src/dist.ts';
import { jdnOf, jdnOfDay } from '../src/grid.ts';
import { GOLD_SIGMA, LADDER, sigmaLadder } from '../src/ladder.ts';
import { CATALOG, createModel, guardsOf } from '../src/markets.ts';
import { type DayBuckets, viewPmDays } from '../src/models/date.ts';
import { FeedModel } from '../src/models/feed.ts';
import { type Built, CONFIRM_MS, DISAGREE_WIDEN, DistModel, STALE_LIMIT_MS, STALE_MS, STALE_WIDEN, type Sizing, disagreement, envelope } from '../src/models/model.ts';
import { OUTAGE_WIDEN, UptimeModel, recency, uptimeDist, windowUptimes } from '../src/models/uptime.ts';
import { parsePmEvent } from '../src/sources/polymarket.ts';
import { parseShowcase, parseUptimePage } from '../src/sources/statuspage.ts';

const F = `${import.meta.dir}/fixtures`;
const sizing: Sizing = { ladder: LADDER, thinMargin: 0.07 };
const market = (m: Partial<Market> & { id: string }): Market => ({
  underlying: 'X',
  horizon: null,
  strikeStep: 1,
  strikeOffset: 0.5,
  spot: null,
  live: true,
  bid: null,
  ask: null,
  bidSize: 0,
  askSize: 0,
  sigma: 0,
  kind: 'fixed',
  status: 'open',
  ...m,
});
const house = market({ id: 'HOUSE-R-2026', strikeMin: 0, strikeMax: 435 });

/** A model whose next reads are given: each read is a uniform 20 seats wide around the next centre. */
class Scripted extends DistModel {
  readonly source = 'scripted';
  next: { centre: number; corroborated?: boolean; widen?: Built['widen'] }[] = [];
  protected async build(): Promise<Built> {
    const r = this.next.shift()!;
    return { dist: new Dist([], [{ lo: r.centre - 10, hi: r.centre + 10, p: 1 }]), thin: false, reports: [], corroborated: r.corroborated, widen: r.widen };
  }
}
const scripted = (...reads: Scripted['next']) => {
  const m = new Scripted(sizing);
  m.guards = { scale: 8, sane: [150, 290] };
  m.next = reads;
  return m;
};
const best = (m: DistModel, now: number) => {
  const t = m.target(house, now);
  return { bid: Math.max(...t.quotes.filter((q) => q.side === 'up').map((q) => q.strike)), ask: Math.min(...t.quotes.filter((q) => q.side === 'down').map((q) => q.strike)), t };
};

describe('fair-value guards', () => {
  test('outside its sane range a fair value is refused: nothing is quoted', async () => {
    const m = scripted({ centre: 120 });
    await m.refresh(0);
    expect(m.target(house, 0).quotes).toEqual([]);
    expect(m.problem).toContain('outside its sane range');
  });

  test('a move bigger than the scale waits for a second read, the book spanning both meanwhile; the second read confirms it', async () => {
    const m = scripted({ centre: 196 }, { centre: 210 }, { centre: 210.5 });
    await m.refresh(0);
    // a uniform over [186, 206): the 46th percentile is 195.2, so the best bid is 194.5 (and the best ask 197.5)
    expect(best(m, 0).bid).toBe(194.5);
    await m.refresh(45_000);
    // still two-sided, safe under both reads: the old read's bids (194.5) and the new one's asks (over [200, 220): 211.5)
    const held = best(m, 45_000);
    expect([held.bid, held.ask]).toEqual([194.5, 211.5]);
    expect(held.t.note).toContain('waiting for a second read');
    await m.refresh(90_000);
    expect(m.held).toBeNull();
    expect(best(m, 90_000).bid).toBeGreaterThan(205);
  });

  test('a streaming model re-reads on every price: a move is believed only once it has held for CONFIRM_MS', async () => {
    const m = scripted({ centre: 196 }, { centre: 210 }, { centre: 210.5 }, { centre: 210.2 });
    await m.refresh(0);
    await m.refresh(1_000);
    await m.refresh(5_000);
    // said again 4 s later: a misprint can sit in a book that long
    expect(m.held).not.toBeNull();
    await m.refresh(1_000 + CONFIRM_MS);
    expect(m.held).toBeNull();
    expect(m.built!.dist.median()).toBeCloseTo(210.2, 9);
  });

  test('two ladders\' envelope: the lower best bid\'s bids, the higher best ask\'s asks; a side either lacks stays out', () => {
    const a = [{ side: 'up' as const, strike: 194.5, size: 1 }, { side: 'up' as const, strike: 192.5, size: 1 }, { side: 'down' as const, strike: 197.5, size: 1 }];
    const b = [{ side: 'up' as const, strike: 208.5, size: 1 }, { side: 'down' as const, strike: 211.5, size: 1 }];
    expect(envelope(a, b).map((q) => q.strike)).toEqual([194.5, 192.5, 211.5]);
    expect(envelope(a, b.filter((q) => q.side === 'up')).map((q) => q.side)).toEqual(['up', 'up']);
  });

  test('a jump that reverts on the next read never becomes the fair value; one two sources confirm does at once', async () => {
    const m = scripted({ centre: 196 }, { centre: 230 }, { centre: 196.5 }, { centre: 230, corroborated: true });
    await m.refresh(0);
    await m.refresh(45_000);
    expect(m.held).not.toBeNull();
    await m.refresh(90_000);
    expect(m.held).toBeNull();
    expect(m.built!.dist.median()).toBeCloseTo(196.5, 9);
    await m.refresh(135_000);
    expect(m.held).toBeNull();
    expect(m.built!.dist.median()).toBeCloseTo(230, 9);
  });

  test('a disagreeing check widens the quotes, and says why', async () => {
    expect(disagreement(196, [{ name: 'Kalshi', median: 197 }], { scale: 8 })).toBeUndefined();
    const w = disagreement(196, [{ name: 'Kalshi', median: 201 }], { scale: 8 });
    expect(w?.by).toBe(DISAGREE_WIDEN);
    expect(w?.why).toContain('Kalshi says 201');
    // on a 20-seat-wide view 3 points is under a strike; 10 points shows the ladder moving out
    const plain = scripted({ centre: 196 });
    const wide = scripted({ centre: 196, widen: { by: 0.1, why: w!.why } });
    await plain.refresh(0);
    await wide.refresh(0);
    expect(best(wide, 0).bid).toBeLessThan(best(plain, 0).bid);
    expect(best(wide, 0).ask).toBeGreaterThan(best(plain, 0).ask);
    expect(best(wide, 0).t.note).toContain('Kalshi says 201');
  });

  test('a source gone quiet: its last read is quoted wider after 10 minutes, and comes down after 2 hours', async () => {
    const m = scripted({ centre: 196 });
    await m.refresh(0);
    const fresh = best(m, STALE_MS - 1);
    const stale = best(m, STALE_MS + 60_000);
    expect(stale.bid).toBeLessThan(fresh.bid);
    expect(stale.t.note).toContain(`${Math.round((LADDER.margin + STALE_WIDEN) * 100)}% from 50/50`);
    expect(m.target(house, STALE_LIMIT_MS + 1).quotes).toEqual([]);
  });
});

describe('gold: quotes off a fresh price, held while there is none', () => {
  const gold = market({ id: 'GOLD-15s', underlying: 'PAXG-USD', kind: 'rolling', horizon: 15, strikeStep: 0.1, strikeOffset: 0, spot: 4028.72, sigma: 0.95 });
  const model = new FeedModel((s, sig, h, g) => sigmaLadder(s, sig, h, g, GOLD_SIGMA), false, 'gold', 4_000);

  test('quotes around the last price while it is fresh; 4 seconds on (the exchange refuses orders at 5) the book is held', () => {
    const tick = { price: 4028.72, live: true, at: 1_000 };
    expect(model.target(gold, 3_000, tick).quotes.length).toBe(20);
    const t = model.target(gold, 5_001, tick);
    expect(t.hold).toBe(true);
    expect(t.reason).toContain('no new price');
  });

  test('a listing that says not live wins over a last price that said live', () => {
    const tick = { price: 4028.72, live: true, at: 1_000 };
    expect(model.target({ ...gold, live: false }, 1_500, tick).hold).toBe(true);
  });
});

describe('uptime over 1, 7 and 30 whole days', () => {
  const showcase = async () => parseShowcase(JSON.parse(await Bun.file(`${F}/statuspage-claude-showcase.json`).text()), 'rwppv331jlwc');

  test('the history pages: each day\'s outage seconds; days to come are skipped', async () => {
    const p1 = parseUptimePage(await Bun.file(`${F}/statuspage-claude-uptime-page1.html`).text());
    const p2 = parseUptimePage(await Bun.file(`${F}/statuspage-claude-uptime-page2.html`).text());
    expect(p1.at(-1)!.day).toBe('2026-10-29');
    expect(p1.find((d) => d.day === '2026-10-27')!.down).toBeCloseTo(0.3 * 3884, 6);
    expect(p2[0].day).toBe('2026-05-01');
    // the pages agree with the 90-day showcase where they overlap
    const show = await showcase();
    const byDay = new Map(p1.map((d) => [d.day, d.down]));
    for (const d of show.filter((x) => x.day < '2026-10-29')) expect(byDay.get(d.day)).toBeCloseTo(d.down, 6);
  });

  test('windows of whole days, today left out: 1, 7 and 30 days', async () => {
    const days = await showcase();
    for (const n of [1, 7, 30]) {
      const w = windowUptimes(days, n, '2026-10-29');
      expect(w).toHaveLength(89 - n + 1);
      expect(w.at(-1)!.end).toBe('2026-10-28');
    }
    // one day: Oct 27 had 3,884 s partial = 1,165 weighted s = 98.65%
    expect(windowUptimes(days, 1, '2026-10-29').find((w) => w.end === '2026-10-27')!.u).toBe(98.65);
  });

  test('recent windows weigh more: a window 30 days back counts half, 90 days back an eighth', () => {
    expect(recency('2026-10-28', '2026-10-28')).toBe(1);
    expect(recency('2026-09-28', '2026-10-28')).toBeCloseTo(0.5, 9);
    expect(recency('2026-07-30', '2026-10-28')).toBeCloseTo(0.125, 9);
    const d = uptimeDist([{ u: 100, w: 1 }, { u: 99, w: 3 }]);
    expect(d.atoms.at(-1)).toEqual([100, 0.25]);
  });

  test('a 1-day book is one-sided (most days are 100%): bids just under 100%, no asks', async () => {
    const days = await showcase();
    const dist = uptimeDist(windowUptimes(days, 1, '2026-10-29').map((w) => ({ u: w.u })));
    expect(dist.atoms.at(-1)![1]).toBeGreaterThan(0.6);
    const m = new UptimeModel({ page: 'atlassian', base: 'x', component: 'y', name: 'claude.ai' }, 1, sizing);
    m.built = { dist, thin: false, reports: [] };
    m.readAt = 0;
    const t = m.target(market({ id: 'CLAUDE-UP-1d', kind: 'rolling', horizon: 86_400, strikeStep: 0.01, strikeOffset: 0.005, strikeMin: 0.005, strikeMax: 99.995 }), 0);
    expect(t.quotes.filter((q) => q.side === 'down')).toEqual([]);
    expect(t.quotes.filter((q) => q.side === 'up')[0].strike).toBe(99.995);
    expect(t.reason).toContain('no ask');
  });

  test('each uptime underlying gets a model for its own horizon in whole days', () => {
    for (const [u, days] of [['CLAUDE-UPTIME-1D', 1], ['CLAUDE-UPTIME-7D', 7], ['POLYMARKET-UPTIME-30D', 30]] as const) {
      const m = createModel(market({ id: 'x', underlying: u, kind: 'rolling', horizon: days * 86_400 }), { sizing, listing: () => market({ id: 'x' }) });
      expect(m).toBeInstanceOf(UptimeModel);
      expect(m!.source).toContain(`${days}-day windows`);
      expect(guardsOf(CATALOG[u], { horizon: days * 86_400 })?.sane).toEqual([90, 100]);
    }
  });

  test('an outage running now widens the book; under 2 hours before midnight UTC (where a fill\'s days start) it comes down', async () => {
    const days = await showcase();
    const page = { page: 'atlassian' as const, base: 'x', component: 'y', name: 'claude.ai' };
    const m7 = market({ id: 'CLAUDE-UP-7d', kind: 'rolling', horizon: 7 * 86_400, strikeStep: 0.01, strikeOffset: 0.005, strikeMin: 0.005, strikeMax: 99.995 });
    const at = (status: 'up' | 'major', iso: string) => {
      const m = new UptimeModel(page, 7, sizing, async () => ({ days, status }));
      m.guards = { scale: 0.15, sane: [90, 100] };
      return m.refresh(Date.parse(iso)).then(() => m.target(m7, Date.parse(iso)));
    };
    const up = await at('up', '2026-10-29T12:00:00Z');
    const down = await at('major', '2026-10-29T12:00:00Z');
    const late = await at('major', '2026-10-29T22:30:00Z');
    const bid = (t: { quotes: { side: string; strike: number }[] }) => Math.max(...t.quotes.filter((q) => q.side === 'up').map((q) => q.strike));
    expect(down.quotes.length).toBeGreaterThan(0);
    expect(bid(down)).toBeLessThan(bid(up));
    expect(down.note).toContain('in a major outage now');
    // on top of what the up book already has (the latest week sits far from the fair value)
    expect(up.note).toContain(`${Math.round((0.06 + DISAGREE_WIDEN) * 100)}% from 50/50`);
    expect(down.note).toContain(`${Math.round((0.06 + DISAGREE_WIDEN + OUTAGE_WIDEN) * 100)}% from 50/50`);
    expect(late.quotes).toEqual([]);
    expect(late.reason).toContain('before midnight UTC');
  });
});

describe('the day-bucket check (Anthropic\'s IPO, "IPO on Nov 18?")', () => {
  test('day buckets as a distribution of the day: median about Nov 19, "No IPO by Nov 30" past it', async () => {
    const ev = parsePmEvent(JSON.parse(await Bun.file(`${F}/polymarket-anthropic-ipo-date.json`).text()));
    const now = Date.parse('2026-10-29T13:00:00Z');
    const src: DayBuckets = { venue: 'polymarket', slug: ev.slug, shape: 'days', zone: 'America/New_York' };
    const v = viewPmDays(ev, src, { zone: 'America/New_York', now, deadline: jdnOf(Date.parse('2026-12-31T12:00:00Z')) });
    const day = Math.round(v.dist.median());
    expect(day).toBeGreaterThanOrEqual(jdnOfDay(2026, 11, 18));
    expect(day).toBeLessThanOrEqual(jdnOfDay(2026, 11, 20));
    // "No IPO by Nov 30" (13¢) sits after Nov 30
    expect(v.dist.above(jdnOfDay(2026, 11, 30) + 0.5)).toBeGreaterThan(0.1);
  });
});
