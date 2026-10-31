import { describe, expect, test } from 'bun:test';
import { Dist } from '../src/dist.ts';
import type { Grid } from '../src/grid.ts';
import { BTC_FEED, GOLD_SIGMA, LADDER, type Quote, type Resting, feedLadder, perRootSecond, plan, quantileLadder, quoteWidth, sigmaLadder, stickiness, sticky } from '../src/ladder.ts';

const bids = (qs: Quote[]) => qs.filter((q) => q.side === 'up').map((q) => q.strike);
const asks = (qs: Quote[]) => qs.filter((q) => q.side === 'down').map((q) => q.strike);
const grid = (step: number, offset: number, min: number | null = null, max: number | null = null): Grid => ({ step, offset, min, max });

describe('the quantile ladder', () => {
  // House seats: a smooth hump over 180-215, strikes on half seats
  const seats = new Dist([], [
    { lo: 179.5, hi: 189.5, p: 0.2 },
    { lo: 189.5, hi: 199.5, p: 0.45 },
    { lo: 199.5, hi: 214.5, p: 0.35 },
  ]);
  const half = grid(1, 0.5, 0, 435);

  test('the best bid and ask are the strikes nearest the median that leave a taker at most 46%', () => {
    const qs = quantileLadder(seats, half);
    const [bid] = bids(qs);
    const [ask] = asks(qs);
    expect(seats.below(bid)).toBeLessThanOrEqual(0.46);
    expect(seats.below(bid + 1)).toBeGreaterThan(0.46);
    expect(seats.above(ask)).toBeLessThanOrEqual(0.46);
    expect(seats.above(ask - 1)).toBeGreaterThan(0.46);
    expect(bid).toBeLessThan(seats.median());
    expect(ask).toBeGreaterThan(seats.median());
    for (const k of [...bids(qs), ...asks(qs)]) expect(Math.abs((k % 1) - 0.5)).toBeLessThan(1e-9);
  });

  test('levels go out at wider quantiles, a strike at least apart, every one keeping its margin', () => {
    const qs = quantileLadder(seats, half);
    const b = bids(qs);
    const a = asks(qs);
    expect(b).toHaveLength(LADDER.levels);
    expect(a).toHaveLength(LADDER.levels);
    b.forEach((k, i) => {
      if (i) expect(k).toBeLessThanOrEqual(b[i - 1] - 1);
      expect(seats.below(k)).toBeLessThanOrEqual(0.46 - 0.04 * i + 1e-12);
    });
    a.forEach((k, i) => {
      if (i) expect(k).toBeGreaterThanOrEqual(a[i - 1] + 1);
      expect(seats.above(k)).toBeLessThanOrEqual(0.46 - 0.04 * i + 1e-12);
    });
    expect(qs.every((q) => q.size === 500)).toBe(true);
  });

  test('a wider margin quotes further out; sizes follow the options', () => {
    const tight = quantileLadder(seats, half);
    const wide = quantileLadder(seats, half, { ...LADDER, margin: 0.1, sizes: [100, 200] });
    expect(bids(wide)[0]).toBeLessThan(bids(tight)[0]);
    expect(asks(wide)[0]).toBeGreaterThan(asks(tight)[0]);
    expect(wide.filter((q) => q.side === 'up').map((q) => q.size).slice(0, 3)).toEqual([100, 200, 200]);
  });

  test('discrete levels (the Fed in 25 bp steps) with strikes between them', () => {
    const fed = new Dist([[3.75, 0.1], [4, 0.25], [4.25, 0.3], [4.5, 0.25], [4.75, 0.1]], []);
    const qs = quantileLadder(fed, grid(0.25, 0.125, 0, 20));
    // P(rate < 4.125) = 35%, P(rate < 4.375) = 65%: the best bid is 4.125; P(rate > 4.375) = 35%: the best ask 4.375
    expect(bids(qs)[0]).toBe(4.125);
    expect(asks(qs)[0]).toBe(4.375);
    // beyond the outcomes, a level a strike further each time, until a taker could hardly ever win
    expect(bids(qs)).toEqual([4.125, 3.875]);
    expect(asks(qs)).toEqual([4.375, 4.625]);
  });

  test('Julian-day strikes: bounded by tonight and the deadline, with the deadline a point mass', () => {
    const today = 2_461_343;
    const deadline = 2_461_405;
    const d = new Dist([[deadline, 0.3]], [{ lo: today - 0.4, hi: today + 40.5, p: 0.7 }]);
    const g = grid(1, 0.5, today + 0.5, deadline - 0.5);
    const qs = quantileLadder(d, g);
    for (const k of [...bids(qs), ...asks(qs)]) {
      expect(k).toBeGreaterThanOrEqual(today + 0.5);
      expect(k).toBeLessThanOrEqual(deadline - 0.5);
      expect(Math.abs((k % 1) - 0.5)).toBeLessThan(1e-9);
    }
    // the deadline's 30% caps how far the asks can climb: every ask leaves Higher (incl. "not by then") ≤ its quantile
    expect(asks(qs).length).toBeLessThan(LADDER.levels);
    expect(d.above(asks(qs).at(-1)!)).toBeGreaterThanOrEqual(0.3);
  });

  test('a side that would cross a bound is pulled: "not by the deadline" at 60% leaves no ask', () => {
    const today = 2_461_343;
    const deadline = 2_461_405;
    const d = new Dist([[deadline, 0.6]], [{ lo: today, hi: today + 30, p: 0.4 }]);
    const qs = quantileLadder(d, grid(1, 0.5, today + 0.5, deadline - 0.5));
    expect(asks(qs)).toEqual([]);
    expect(bids(qs).length).toBeGreaterThan(0);
  });

  test('a floor (a count that can only rise) leaves no pointless bids under it', () => {
    const d = new Dist([], [{ lo: 281.5, hi: 299.5, p: 0.3 }, { lo: 299.5, hi: 319.5, p: 0.7 }]);
    const qs = quantileLadder(d, grid(1, 0.5, 0.5));
    for (const k of bids(qs)) expect(d.below(k)).toBeGreaterThanOrEqual(LADDER.minTake);
    expect(Math.min(...bids(qs))).toBeGreaterThan(281.5);
  });

  test('an atom on a strike would cross the book: nothing is quoted', () => {
    expect(quantileLadder(new Dist([[10.5, 1]], []), grid(1, 0.5))).toEqual([]);
  });

  test('negative strikes: a Democratic-minus-Republican margin, with Republican wins below zero', () => {
    const d = new Dist([], [{ lo: -6, hi: 0, p: 0.4 }, { lo: 0, hi: 18, p: 0.6 }]);
    const qs = quantileLadder(d, grid(0.1, 0.05, -100, 100));
    expect(bids(qs).some((k) => k < 0)).toBe(true);
    expect(asks(qs).every((k) => k > 0)).toBe(true);
    for (const k of [...bids(qs), ...asks(qs)]) {
      const n = (k - 0.05) * 10;
      expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-6);
    }
  });
});

describe('the feed ladder (BTC, as Rizon\'s maker has always quoted it)', () => {
  const SEED = perRootSecond(BTC_FEED.vol);
  const sigmaAt = (spot: number, horizon: number, sigmaS = SEED) => spot * sigmaS * Math.sqrt(horizon);
  const dollars = grid(1, 0);

  test('best bid and ask are 2 / 4 / 9 strikes apart in calm markets, widening up to 3x with volatility', () => {
    expect([15, 60, 300].map((h) => quoteWidth(h, SEED))).toEqual([2, 4, 9]);
    expect([15, 60, 300].map((h) => quoteWidth(h, SEED / 2))).toEqual([2, 4, 9]);
    expect([15, 60, 300].map((h) => quoteWidth(h, 2 * SEED))).toEqual([4, 8, 18]);
    expect(quoteWidth(15, 10 * SEED)).toBe(6);
  });

  test('centred on spot, ten levels a side of one size, the outer nine on a grid of 6% of sigma', () => {
    const spot = 100_000.4;
    for (const horizon of [15, 60, 300]) {
      const sigma = sigmaAt(spot, horizon);
      const qs = feedLadder(spot, sigma, horizon, dollars);
      const b = bids(qs);
      const a = asks(qs);
      const width = quoteWidth(horizon, SEED);
      const spacing = Math.max(1, Math.round(0.06 * sigma));
      expect(b).toHaveLength(10);
      expect(a).toHaveLength(10);
      expect(b[0]).toBe(Math.round(spot - width / 2));
      expect(a[0] - b[0]).toBe(width);
      for (const k of [...b.slice(1), ...a.slice(1)]) expect(k % spacing).toBe(0);
      expect(b.slice(1).every((k, i) => k < b[i])).toBe(true);
      expect(a.slice(1).every((k, i) => k > a[i])).toBe(true);
    }
    expect(feedLadder(spot, sigmaAt(spot, 15), 15, dollars).every((q) => q.size === 1_000)).toBe(true);
  });

  test('without a sigma yet it quotes at the calibration volatility', () => {
    expect(feedLadder(100_000, 0, 60, dollars)).toEqual(feedLadder(100_000, sigmaAt(100_000, 60), 60, dollars));
  });

  test('near $80,000 the calm touch is about ±0.04σ: what gold\'s sigma ladder copies', () => {
    for (const horizon of [15, 60, 300]) {
      const sigma = sigmaAt(80_000, horizon);
      const qs = feedLadder(80_000.4, sigma, horizon, dollars);
      expect((asks(qs)[0] - bids(qs)[0]) / 2 / sigma).toBeGreaterThan(0.035);
      expect((asks(qs)[0] - bids(qs)[0]) / 2 / sigma).toBeLessThan(0.045);
    }
  });
});

describe('the sigma ladder (Gold: BTC in sigmas)', () => {
  const cents = grid(0.1, 0);
  const sigmaOf = (spot: number, horizon: number, vol: number) => spot * perRootSecond(vol) * Math.sqrt(horizon);

  test('each side sits at least 0.04σ from spot, and less than a strike further, wherever spot is in its strike', () => {
    for (const horizon of [15, 60, 300]) {
      const sigma = sigmaOf(4027, horizon, 0.18);
      for (let c = 0; c < 10; c++) {
        const spot = 4027 + c / 100 + 0.003;
        const qs = sigmaLadder(spot, sigma, horizon, cents);
        const [bid] = bids(qs);
        const [ask] = asks(qs);
        expect(spot - bid).toBeGreaterThanOrEqual(0.04 * sigma - 1e-9);
        expect(spot - bid).toBeLessThan(0.04 * sigma + 0.1);
        expect(ask - spot).toBeGreaterThanOrEqual(0.04 * sigma - 1e-9);
        expect(ask - spot).toBeLessThan(0.04 * sigma + 0.1);
      }
    }
  });

  test('ten levels a side of one size, the outer nine on multiples of 6% of sigma (at least a strike), on the $0.10 grid', () => {
    // at 18% a year 6% of sigma is under a strike to 5 m; at 24% the 5-minute levels are two strikes apart
    for (const [horizon, vol, step] of [[15, 0.18, 1], [60, 0.18, 1], [300, 0.18, 1], [300, 0.24, 2]] as const) {
      const sigma = sigmaOf(4027, horizon, vol);
      const qs = sigmaLadder(4027.33, sigma, horizon, cents);
      expect(Math.max(1, Math.round((0.06 * sigma) / 0.1))).toBe(step);
      expect(bids(qs)).toHaveLength(10);
      expect(asks(qs)).toHaveLength(10);
      for (const k of [...bids(qs).slice(1), ...asks(qs).slice(1)]) expect(Math.round(k * 10) % step).toBe(0);
      for (const q of qs) expect(Math.abs(q.strike * 10 - Math.round(q.strike * 10))).toBeLessThan(1e-6);
      expect(qs.every((q) => q.size === GOLD_SIGMA.size)).toBe(true);
    }
  });

  test('sigma is never taken under 12% a year: a quiet spell (or no sigma yet) quotes as calm gold, not tighter', () => {
    const calm = sigmaOf(4027, 60, GOLD_SIGMA.minVol);
    expect(sigmaLadder(4027.33, 0, 60, cents)).toEqual(sigmaLadder(4027.33, calm, 60, cents));
    expect(sigmaLadder(4027.33, calm / 10, 60, cents)).toEqual(sigmaLadder(4027.33, calm, 60, cents));
  });

  test('a ten-cent move re-quotes the best levels and an end, not the ladder', () => {
    const sigma = sigmaOf(4027, 60, 0.18);
    const before = sigmaLadder(4027.33, sigma, 60, cents);
    const resting: Resting[] = before.map((q, i) => ({ id: `o${i}`, market: 'GOLD-1m', side: q.side, strike: q.strike, remaining: q.size }));
    const p = plan(sigmaLadder(4027.43, sigma, 60, cents), resting, 4027.43);
    expect(p.place.length).toBeLessThanOrEqual(4);
    expect(p.cancel.length).toBe(p.place.length);
  });
});

describe('re-quoting', () => {
  const SEED = perRootSecond(BTC_FEED.vol);
  const sigmaAt = (spot: number, horizon: number) => spot * SEED * Math.sqrt(horizon);
  const dollars = grid(1, 0);
  const restingFrom = (qs: Quote[], market = 'BTC-15s'): Resting[] => qs.map((q, i) => ({ id: `o${i}`, market, side: q.side, strike: q.strike, remaining: q.size }));

  test('a move of one strike costs two new quotes and two cancels, whatever the spacing', () => {
    for (const horizon of [15, 60, 300]) {
      const sigma = sigmaAt(100_000, horizon);
      const before = feedLadder(100_000, sigma, horizon, dollars);
      const p = plan(feedLadder(100_001, sigma, horizon, dollars), restingFrom(before), 100_001);
      expect(p.place.length).toBeLessThanOrEqual(4);
      expect(p.cancel.length).toBe(p.place.length);
    }
    const before = feedLadder(100_000, sigmaAt(100_000, 15), 15, dollars);
    expect(plan(feedLadder(100_001, sigmaAt(100_000, 15), 15, dollars), restingFrom(before), 100_001).place).toHaveLength(2);
  });

  test('nothing changes while spot stays near the same strike', () => {
    const sigma = sigmaAt(100_000, 15);
    const before = feedLadder(100_000.1, sigma, 15, dollars);
    expect(plan(feedLadder(100_000.3, sigma, 15, dollars), restingFrom(before), 100_000.3)).toEqual({ cancel: [], place: [] });
  });

  test('new quotes go out nearest the centre first; strays, duplicates and half-filled quotes are replaced', () => {
    const target = feedLadder(100_000, sigmaAt(100_000, 15), 15, dollars);
    const resting: Resting[] = [
      { id: 'keep', market: 'BTC-15s', side: 'up', strike: 99_999, remaining: 1_000 },
      { id: 'dup', market: 'BTC-15s', side: 'up', strike: 99_999, remaining: 1_000 },
      { id: 'thin', market: 'BTC-15s', side: 'down', strike: 100_001, remaining: 499 },
      { id: 'stray', market: 'BTC-15s', side: 'down', strike: 100_500, remaining: 1_000 },
    ];
    const p = plan(target, resting, 100_000);
    expect(p.cancel.sort()).toEqual(['dup', 'stray', 'thin']);
    expect(p.place).toHaveLength(target.length - 1);
    const distances = p.place.map((q) => Math.abs(q.strike - 100_000));
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(p.place[0]).toEqual({ side: 'down', strike: 100_001, size: 1_000 });
  });

  test('an event ladder that shifts re-quotes only the levels that moved; float strikes compare exactly', () => {
    // a uniform over half a point: levels sit 2 strikes apart, so a shift of 2 strikes leaves all but the ends
    const d = (shift: number) => new Dist([], [{ lo: 5 + shift, hi: 5.5 + shift, p: 1 }]);
    const g = grid(0.01, 0.005, 0, 100);
    const before = quantileLadder(d(0), g);
    const after = quantileLadder(d(0.02), g);
    const p = plan(after, restingFrom(before, 'UST10Y-MAX-2026').map((r) => ({ ...r, strike: r.strike + 1e-12 })), 5.27);
    expect(p.cancel).toHaveLength(2);
    expect(p.place).toHaveLength(2);
    expect(plan(before, restingFrom(before, 'UST10Y-MAX-2026'), 5.25)).toEqual({ cancel: [], place: [] });
  });
});

describe('sticky feed books: the side a move left safer may lag', () => {
  const dollars = grid(1, 0);
  const sigma = 24.85; // BTC over 15 s
  const at = (spot: number) => feedLadder(spot, sigma, 15, dollars);
  const rest = (qs: Quote[]): Resting[] => qs.map((q, i) => ({ id: `o${i}`, market: 'BTC-15s', side: q.side, strike: q.strike, remaining: q.size }));
  const { slack, tolerance } = stickiness(sigma, 1);

  test('a strike up moves the asks only; a strike back moves nothing; two strikes up moves both sides', () => {
    expect([slack, tolerance]).toEqual([1, 0]);
    const resting = rest(at(100_000.4));
    const up = plan(sticky(at(100_001.4), resting, 1, slack, tolerance), resting, 100_001.4);
    expect(up.place.map((q) => q.side)).toEqual(['down']);
    // the book after it: bids where they were, asks a strike up
    const moved = rest([...at(100_000.4).filter((q) => q.side === 'up'), ...at(100_001.4).filter((q) => q.side === 'down')]);
    expect(plan(sticky(at(100_000.4), moved, 1, slack, tolerance), moved, 100_000.4)).toEqual({ cancel: [], place: [] });
    const twoUp = plan(sticky(at(100_002.4), resting, 1, slack, tolerance), resting, 100_002.4);
    expect(new Set(twoUp.place.map((q) => q.side))).toEqual(new Set(['up', 'down']));
  });

  test('a long horizon tolerates more: BTC-5m lags up to 4 strikes away and 2 nearer', () => {
    expect(stickiness(111.1, 1)).toEqual({ slack: 4, tolerance: 2 });
    expect(stickiness(0.5, 0.1)).toEqual({ slack: 1, tolerance: 0 });
  });

  test('a side with missing levels (a fill took one) takes the target', () => {
    const resting = rest(at(100_000.4)).filter((o, i) => !(o.side === 'down' && i === 1));
    const p = plan(sticky(at(100_000.4), resting, 1, slack, tolerance), resting, 100_000.4);
    expect(p.place.map((q) => q.side)).toEqual(['down']);
  });
});
