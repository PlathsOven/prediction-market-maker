// ELON-1d and ELON-7d: the post history (XTracker's post list, recorded 2026-10-29 at 23:10 UTC: 90 days, 3,075
// posts), the rate and the spread learned from it, the shared history's reads, and the books quoted around the
// count now.
import { describe, expect, test } from 'bun:test';
import type { Market } from '../src/api.ts';
import { LADDER } from '../src/ladder.ts';
import { CATALOG, createModel, guardsOf } from '../src/markets.ts';
import { ElonModel, type PolymarketView, countIn, forecast, rateAt } from '../src/models/elon.ts';
import type { Sizing } from '../src/models/model.ts';
import { type Post, PostLog, parsePosts } from '../src/sources/xtracker.ts';

const sizing: Sizing = { ladder: LADDER, thinMargin: 0.07 };
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-29T23:10:00Z');
const FROM = Date.parse('2026-07-31T00:00:00Z');
const posts = parsePosts(JSON.parse(await Bun.file(`${import.meta.dir}/fixtures/xtracker-posts-90d.json`).text()));
const times = posts.map((p) => p.at);

const elon = (horizon: number, spot: number | null = 11_500): Market => ({
  id: horizon === 86_400 ? 'ELON-1d' : 'ELON-7d',
  underlying: 'ELON-POSTS',
  kind: 'rolling',
  horizon,
  unit: 'count',
  strikeStep: 1,
  strikeOffset: 0.5,
  spot,
  live: true,
  bid: null,
  ask: null,
  bidSize: 0,
  askSize: 0,
  sigma: 0,
  status: 'open',
});
const touch = (qs: { side: string; strike: number }[]) => ({
  bid: Math.max(...qs.filter((q) => q.side === 'up').map((q) => q.strike)),
  ask: Math.min(...qs.filter((q) => q.side === 'down').map((q) => q.strike)),
});
/** A model on the recorded history, with a Polymarket view that says what it's given (by default, the history's own pace). */
const model = async (days: number, check = (_now: number, hMs: number): Promise<PolymarketView> => Promise.resolve({ name: 'Polymarket', median: (46.5 * hMs) / DAY, fit: 1 })) => {
  const log = new PostLog('elonmusk', 90, async (from) => posts.filter((p) => p.at >= from));
  const m = new ElonModel(days, log, sizing, check);
  m.guards = guardsOf(CATALOG['ELON-POSTS'], { horizon: days * 86_400 });
  await m.refresh(NOW);
  return m;
};

describe('the post history', () => {
  test('XTracker\'s post list: each post\'s id and when it was recorded, oldest first', () => {
    expect(posts).toHaveLength(3_075);
    expect(new Date(times[0]).toISOString()).toBe('2026-08-01T00:10:26.006Z');
    expect(new Date(times.at(-1)!).toISOString()).toBe('2026-10-29T23:06:12.097Z');
    expect(times.every((t, i) => i === 0 || t >= times[i - 1])).toBe(true);
    expect(parsePosts({ data: [{ id: 'a', importedAt: 'nope' }, { importedAt: '2026-10-29T00:00:00Z' }] })).toEqual([]);
  });

  test('the rate: posts a day over the last 28 days, a day a week back counting half', () => {
    // a post every hour, for 40 days: 24 a day, however it's weighted
    const hourly = Array.from({ length: 40 * 24 }, (_, i) => NOW - i * 3_600_000 - 1).reverse();
    expect(rateAt(hourly, NOW)).toBeCloseTo(24, 9);
    // the last 7 days held 326 posts, the last 28 1,274: lately 46.6 a day, over the 4 weeks' plain 45.5
    expect(countIn(times, NOW - 7 * DAY, NOW)).toBe(326);
    expect(countIn(times, NOW - 28 * DAY, NOW)).toBe(1_274);
    expect(rateAt(times, NOW)).toBeCloseTo(46.6, 1);
  });

  test('a steady pace: the forecast is the rate times the horizon, give or take half a Poisson count', () => {
    const hourly = Array.from({ length: 90 * 24 }, (_, i) => NOW - i * 3_600_000 - 1).reverse();
    const f = forecast(hourly, NOW - 90 * DAY, NOW, DAY);
    expect(f.expected).toBeCloseTo(24, 9);
    expect(f.dist.median()).toBeCloseTo(24, 0);
    // every past day held 24: the spread is the smoothing alone, ±√(3 × 24)/2 ≈ ±4.2, evenly
    expect(f.dist.quantile(0.25)).toBeCloseTo(24 - 2.1, 0);
  });

  test('1 day: about 46.5 posts to come, the 46th to 54th percentile 44.8 to 48.2, from 248 past days', () => {
    const f = forecast(times, FROM, NOW, DAY);
    expect(f.samples).toBe(248);
    expect(f.dist.median()).toBeCloseTo(46.5, 0);
    expect(f.dist.quantile(0.46)).toBeCloseTo(44.8, 0);
    expect(f.dist.quantile(0.54)).toBeCloseTo(48.2, 0);
    // a wide day either way: a quiet one under 27 one time in ten, a binge over 72
    expect(f.dist.quantile(0.1)).toBeGreaterThan(20);
    expect(f.dist.quantile(0.9)).toBeLessThan(80);
    expect(f.dist.support()[0]).toBeGreaterThanOrEqual(-0.5);
  });

  test('7 days: about 325 to come; past weeks ran 7% ahead of their rate (his pace doubled), and that is taken out', () => {
    const f = forecast(times, FROM, NOW, 7 * DAY);
    expect(f.drift).toBeCloseTo(1.07, 2);
    expect(f.dist.median()).toBeCloseTo(f.expected, -1);
    expect(f.dist.median()).toBeGreaterThan(315);
    expect(f.dist.median()).toBeLessThan(335);
  });

  test('too short a history to learn a spread from is an error, not a guess', () => {
    expect(() => forecast(times, NOW - 30 * DAY, NOW, 7 * DAY)).toThrow('past 7-day horizons');
  });
});

describe('the shared history', () => {
  const at = (id: string, t: number): Post => ({ id, at: t });
  test('90 days once, then the last 3 days every 10 minutes, merged by id; a short whole read keeps the last', async () => {
    const asked: number[] = [];
    let next: Post[] = [];
    const log = new PostLog('elonmusk', 90, async (from) => {
      asked.push(from);
      return next;
    });
    next = Array.from({ length: 200 }, (_, i) => at(`p${i}`, NOW - 89 * DAY + i * 3_600_000));
    await Promise.all([log.refresh(NOW), log.refresh(NOW)]);
    // one read for both books
    expect(asked).toEqual([NOW - 90 * DAY]);
    expect(log.times).toHaveLength(200);
    next = [at('p199', NOW - 89 * DAY + 199 * 3_600_000), at('new', NOW + 60_000)];
    await log.refresh(NOW + 5 * 60_000);
    expect(asked).toHaveLength(1);
    await log.refresh(NOW + 11 * 60_000);
    expect(asked.at(-1)).toBe(NOW + 11 * 60_000 - 3 * DAY);
    expect(log.times).toHaveLength(201);
    // 6 hours on, the whole history again: one that's nearly empty is refused and the last kept
    next = [at('x', NOW)];
    await expect(log.refresh(NOW + 7 * 3_600_000)).rejects.toThrow('looks short');
    expect(log.times).toHaveLength(201);
  });
});

describe('the ELON books', () => {
  test('ELON-1d at 11,500 posts: bids from 11,544.5 down, asks from 11,548.5 up, on half posts', async () => {
    const m = await model(1);
    const t = m.target(elon(86_400), NOW, { price: 11_500, live: true, at: NOW });
    expect(touch(t.quotes)).toEqual({ bid: 11_544.5, ask: 11_548.5 });
    expect(t.quotes.every((q) => q.strike % 1 === 0.5)).toBe(true);
    expect(t.center).toBeCloseTo(11_546.5, 0);
    expect(t.reason).toBeUndefined();
    // eight levels a side, every one where a taker wins under half the time
    expect(t.quotes.filter((q) => q.side === 'up')).toHaveLength(8);
    expect(t.quotes.filter((q) => q.side === 'down')).toHaveLength(8);
  });

  test('each post moves the book a strike', async () => {
    const m = await model(1);
    const a = touch(m.target(elon(86_400), NOW, { price: 11_500, live: true, at: NOW }).quotes);
    const b = touch(m.target(elon(86_400), NOW, { price: 11_501, live: true, at: NOW }).quotes);
    expect(b).toEqual({ bid: a.bid + 1, ask: a.ask + 1 });
  });

  test('ELON-7d: about 325 to come, a 10-post spread', async () => {
    const m = await model(7);
    const t = m.target(elon(604_800), NOW, { price: 11_500, live: true, at: NOW });
    expect(touch(t.quotes)).toEqual({ bid: 11_820.5, ask: 11_830.5 });
  });

  test('Polymarket far from it: the forecast moves halfway there (in ratio), and the book widens while they disagree', async () => {
    const own = forecast(times, FROM, NOW, 7 * DAY).dist.median();
    const m = await model(7, async () => ({ name: 'Polymarket elon-musk-of-tweets-october-30-november-6-2026', median: 280, fit: 1 }));
    const t = m.target(elon(604_800), NOW, { price: 11_500, live: true, at: NOW });
    expect(t.center - 11_500).toBeCloseTo(own * Math.sqrt(281 / (own + 1)), 6);
    expect(t.center - 11_500).toBeCloseTo(302, 0);
    expect(t.note).toContain('says 280');
    // the same view from a window that matches the horizon half as well, or from a thin book, moves it half as far
    for (const view of [{ fit: 0.5 }, { fit: 1, thin: true }]) {
      const half = await model(7, async () => ({ name: 'Polymarket', median: 280, ...view }));
      expect(half.target(elon(604_800), NOW, { price: 11_500, live: true, at: NOW }).center - 11_500).toBeCloseTo(own * (281 / (own + 1)) ** 0.25, 6);
    }
  });

  test('no Polymarket view (no open window, or it failed): the history alone, quoted as usual', async () => {
    const m = await model(1, async () => {
      throw new Error('no open Polymarket window to check against');
    });
    const t = m.target(elon(86_400), NOW, { price: 11_500, live: true, at: NOW });
    expect(touch(t.quotes)).toEqual({ bid: 11_544.5, ask: 11_548.5 });
    expect(m.current(NOW)!.reports[0].error).toContain('no open Polymarket window');
  });

  test('Rizon\'s counter not live: the book is held as it is; with no count yet, nothing', async () => {
    const m = await model(1);
    const held = m.target(elon(86_400), NOW, { price: 11_500, live: false, at: NOW });
    expect(held.hold).toBe(true);
    expect(held.reason).toContain("counter isn't live");
    expect(m.target(elon(86_400, null), NOW).reason).toBe('no count yet');
    // an exchange that trades on a stand-in count (FEED=sim in dev): quoted as usual
    const log = new PostLog('elonmusk', 90, async (from) => posts.filter((p) => p.at >= from));
    const sim = new ElonModel(1, log, sizing, async () => ({ name: 'Polymarket', median: 46.5, fit: 1 }), true);
    await sim.refresh(NOW);
    expect(sim.target(elon(86_400), NOW, { price: 11_500, live: false, at: NOW }).quotes.length).toBe(16);
  });

  test('each horizon has its own model and guards (on the posts to come)', () => {
    const deps = { sizing, listing: () => elon(86_400) };
    const d1 = createModel(elon(86_400), deps);
    const d7 = createModel(elon(604_800), deps);
    expect(d1).toBeInstanceOf(ElonModel);
    expect((d7 as ElonModel).days).toBe(7);
    expect((d1 as ElonModel).guards?.scale).toBe(10);
    expect((d7 as ElonModel).guards?.scale).toBe(50);
  });
});
