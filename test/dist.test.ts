import { describe, expect, test } from 'bun:test';
import { Dist, isotonic, normCdf, normInv } from '../src/dist.ts';
import { axisOf, dayOfJdn, endOfDayIn, jdnOf, jdnOfDay, msOfJd, tzOffsetHours } from '../src/grid.ts';

describe('distributions: atoms and uniform segments', () => {
  test('a bucket spreads its probability evenly; tails are read from either side', () => {
    // seats: 30% on 190-194 ([189.5, 194.5)), 70% on 195-199
    const d = new Dist([], [
      { lo: 189.5, hi: 194.5, p: 0.3 },
      { lo: 194.5, hi: 199.5, p: 0.7 },
    ]);
    expect(d.below(192)).toBeCloseTo(0.15, 12);
    expect(d.above(192)).toBeCloseTo(0.85, 12);
    expect(d.cdf(194.5)).toBeCloseTo(0.3, 12);
    // the median: 20% of the way into the second bucket's 70%
    expect(d.median()).toBeCloseTo(194.5 + (5 * 0.2) / 0.7, 9);
    expect(d.support()).toEqual([189.5, 199.5]);
  });

  test('weights are normalised; zero and empty pieces are dropped; an empty distribution throws', () => {
    const d = new Dist([[1, 2]], [{ lo: 0, hi: 1, p: 2 }, { lo: 5, hi: 6, p: 0 }]);
    expect(d.atoms).toEqual([[1, 0.5]]);
    expect(d.segments).toEqual([{ lo: 0, hi: 1, p: 0.5 }]);
    expect(() => new Dist([], [])).toThrow();
  });

  test('point masses: strict and non-strict sides differ exactly at the atom, and quantiles land on it', () => {
    // the Fed at 4.00% (30%), 4.25% (50%), 4.50% (20%)
    const d = new Dist([[4, 0.3], [4.25, 0.5], [4.5, 0.2]], []);
    expect(d.below(4.25)).toBeCloseTo(0.3, 12);
    expect(d.cdf(4.25)).toBeCloseTo(0.8, 12);
    expect(d.above(4.25)).toBeCloseTo(0.2, 12);
    expect(d.median()).toBe(4.25);
    expect(d.quantile(0.3)).toBe(4);
    expect(d.quantile(0.31)).toBe(4.25);
    expect(d.quantile(0.95)).toBe(4.5);
  });

  test('mixed atoms and segments: the CDF is linear between breakpoints and jumps at atoms', () => {
    // a date market: 60% spread over 20 days, then 40% on the deadline
    const d = new Dist([[2_461_405, 0.4]], [{ lo: 2_461_343, hi: 2_461_363, p: 0.6 }]);
    expect(d.quantile(0.3)).toBeCloseTo(2_461_353, 9);
    expect(d.quantile(0.6)).toBeCloseTo(2_461_363, 9);
    expect(d.quantile(0.61)).toBe(2_461_405);
    expect(d.below(2_461_404.5)).toBeCloseTo(0.6, 12);
    expect(d.above(2_461_404.5)).toBeCloseTo(0.4, 12);
  });

  test('truncate: what is left once a floor is known, renormalised', () => {
    // posts: 50% in [279.5, 299.5), 50% in [299.5, 319.5); the count is already 290
    const d = new Dist([], [
      { lo: 279.5, hi: 299.5, p: 0.5 },
      { lo: 299.5, hi: 319.5, p: 0.5 },
    ]).truncate(289.5);
    expect(d.below(289.5)).toBe(0);
    expect(d.below(299.5)).toBeCloseTo(0.25 / 0.75, 12);
    expect(d.support()).toEqual([289.5, 319.5]);
  });

  test('capAt moves the mass beyond a point onto it (a deadline)', () => {
    const capped = new Dist([], [{ lo: 0, hi: 10, p: 1 }]).capAt(8);
    expect(capped.atoms).toEqual([[8, expect.closeTo(0.2, 12)]]);
    expect(capped.below(8)).toBeCloseTo(0.8, 12);
  });

  test('mix: a weighted mixture of distributions', () => {
    const a = new Dist([], [{ lo: 0, hi: 1, p: 1 }]);
    const b = new Dist([[5, 1]], []);
    const m = Dist.mix([[a, 3], [b, 1]]);
    expect(m.below(1)).toBeCloseTo(0.75, 12);
    expect(m.above(4)).toBeCloseTo(0.25, 12);
    expect(Dist.mix([[a, 1], [b, 0]]).atoms).toEqual([]);
  });

  test('fromCdf: linear between points; flat steps add nothing; leftover mass sits on the last point', () => {
    const d = Dist.fromCdf([[0, 0], [10, 0.5], [20, 0.5], [30, 0.9]]);
    expect(d.below(5)).toBeCloseTo(0.25, 12);
    expect(d.below(15)).toBeCloseTo(0.5, 12);
    expect(d.quantile(0.7)).toBeCloseTo(25, 9);
    expect(d.atoms).toEqual([[30, expect.closeTo(0.1, 12)]]);
  });
});

describe('monotone fits and the normal distribution', () => {
  test('isotonic: crossing prices are pooled, weighted', () => {
    expect(isotonic([0.1, 0.3, 0.2, 0.5])).toEqual([0.1, 0.25, 0.25, 0.5]);
    // the tighter quote (weight 3) wins most of the pooled value
    expect(isotonic([0.4, 0.2], [1, 3])).toEqual([0.25, 0.25]);
    expect(isotonic([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
  });

  test('Φ and Φ⁻¹', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normCdf(-1)).toBeCloseTo(0.158655, 5);
    for (const p of [0.01, 0.2, 0.5, 0.795, 0.99]) expect(normCdf(normInv(p))).toBeCloseTo(p, 6);
  });
});

describe('Julian days and time zones', () => {
  test('JDN: 2026-10-29 is 2,461,343; JD x.5 is a UTC midnight', () => {
    expect(jdnOf(Date.parse('2026-10-29T00:00:00Z'))).toBe(2_461_343);
    expect(jdnOf(Date.parse('2026-10-29T23:59:59Z'))).toBe(2_461_343);
    expect(jdnOfDay(2026, 11, 15)).toBe(2_461_360);
    expect(new Date(msOfJd(2_461_359.5)).toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(dayOfJdn(2_461_343)).toBe('2026-10-29');
  });

  test('zone offsets follow daylight saving; Tehran keeps +3:30', () => {
    expect(tzOffsetHours(Date.parse('2026-10-29T12:00:00Z'), 'America/New_York')).toBe(-4);
    expect(tzOffsetHours(Date.parse('2026-11-02T12:00:00Z'), 'America/New_York')).toBe(-5);
    expect(tzOffsetHours(Date.parse('2026-10-29T12:00:00Z'), 'Asia/Tehran')).toBe(3.5);
    expect(tzOffsetHours(Date.parse('2026-10-29T12:00:00Z'), 'UTC')).toBe(0);
  });

  test('the end of a day in a zone, and where a moment sits on a market clock', () => {
    // Nov 15 ends at 05:00 UTC Nov 16 in New York (EST), at 20:30 UTC Nov 15 in Tehran
    expect(new Date(endOfDayIn(jdnOfDay(2026, 11, 15), 'America/New_York')).toISOString()).toBe('2026-11-16T05:00:00.000Z');
    expect(new Date(endOfDayIn(jdnOfDay(2026, 11, 15), 'Asia/Tehran')).toISOString()).toBe('2026-11-15T20:30:00.000Z');
    // on its own clock a day's end is exactly the strike after it; on UTC's, Tehran's midnight is 3.5 hours early
    expect(axisOf(endOfDayIn(jdnOfDay(2026, 11, 15), 'America/New_York'), 'America/New_York')).toBeCloseTo(2_461_360.5, 9);
    expect(axisOf(endOfDayIn(jdnOfDay(2026, 11, 15), 'Asia/Tehran'), 'UTC')).toBeCloseTo(2_461_360.5 - 3.5 / 24, 9);
  });
});
