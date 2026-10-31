// The Polymarket readers on responses recorded from the Gamma API on 2026-10-29 at about 09:00 UTC (trimmed to
// the fields the bots read). The implied medians are the ones the research read by hand that morning.
import { describe, expect, test } from 'bun:test';
import { type PolymarketBuckets, type PolymarketLadder, rangeOfEdges, viewPmBuckets, viewPmLadder } from '../src/analogs.ts';
import { fitBuckets, fitPoints, interval } from '../src/buckets.ts';
import { jdnOf, jdnOfDay } from '../src/grid.ts';
import { CATALOG, offlineListings } from '../src/markets.ts';
import { type DateSource, viewPmDates } from '../src/models/date.ts';
import { THIN_SPREAD, Unreadable } from '../src/models/model.ts';
import { USD_BILLIONS, parseDateLabel, parseLabel, parsePmEvent, tradingMarkets } from '../src/sources/polymarket.ts';

const fixture = async (slug: string) => parsePmEvent(JSON.parse(await Bun.file(`${import.meta.dir}/fixtures/polymarket-${slug}.json`).text()));
const NOW = Date.parse('2026-10-29T09:00:00Z');
const spec = (u: string) => {
  const s = CATALOG[u].spec;
  if (s.model !== 'event') throw new Error(`${u} is not an event market`);
  return s;
};
const optionsOf = (u: string) => {
  const s = spec(u);
  return { value: s.value, support: s.support, drop: s.drop, conditional: s.conditional };
};

describe('labels', () => {
  test('bucket labels in every shape the venues use', () => {
    expect(parseLabel('195-199')).toEqual({ kind: 'range', a: 195, b: 199 });
    expect(parseLabel('Below 190')).toEqual({ kind: 'below', a: 190 });
    expect(parseLabel('≤47')).toEqual({ kind: 'atMost', a: 47 });
    expect(parseLabel('57+')).toEqual({ kind: 'atLeast', a: 57 });
    expect(parseLabel('48')).toEqual({ kind: 'exact', a: 48 });
    expect(parseLabel('<20')).toEqual({ kind: 'below', a: 20 });
    expect(parseLabel('4.25%')).toEqual({ kind: 'exact', a: 4.25 });
    expect(parseLabel('≥6.0%')).toEqual({ kind: 'atLeast', a: 6 });
    expect(parseLabel('$1.25–$1.5T', { scale: USD_BILLIONS })).toEqual({ kind: 'range', a: 1250, b: 1500 });
    expect(parseLabel('<$1.25T', { scale: USD_BILLIONS })).toEqual({ kind: 'below', a: 1250 });
    expect(parseLabel('$3.0T+', { scale: USD_BILLIONS })).toEqual({ kind: 'atLeast', a: 3000 });
    expect(parseLabel('$50M', { scale: USD_BILLIONS })).toEqual({ kind: 'exact', a: 0.05 });
    expect(parseLabel('$1.5B', { scale: USD_BILLIONS })).toEqual({ kind: 'exact', a: 1.5 });
    // a Republican bucket on a Democratic margin is negative
    const signs = { signs: { Democrats: 1 as const, Republicans: -1 as const } };
    expect(parseLabel('Democrats 14-16%', signs)).toEqual({ kind: 'range', a: 14, b: 16 });
    expect(parseLabel('Republicans 2-4%', signs)).toEqual({ kind: 'range', a: -4, b: -2 });
    expect(parseLabel('Republicans 6%+', signs)).toEqual({ kind: 'atMost', a: -6 });
    // words it doesn't know are refused, not guessed
    expect(parseLabel('Other')).toBeNull();
    expect(parseLabel('No IPO by December 31, 2027')).toBeNull();
    expect(parseLabel('$1.5T')).toBeNull(); // no scale for T given
  });

  test('every bucket edge written in the market table agrees with what its label says', async () => {
    for (const [u, entry] of Object.entries(CATALOG)) {
      const s = entry.spec;
      if (s.model !== 'event') continue;
      for (const src of s.sources) {
        if (src.venue !== 'polymarket' || src.shape) continue;
        const b = src as PolymarketBuckets;
        const groups: [string, Record<string, readonly [number | null, number | null]> | undefined][] = [[b.slug, b.edges]];
        if (b.refine) groups.push([b.refine.slug, b.refine.edges]);
        for (const [slug, edges] of groups) {
          const ev = await fixture(slug);
          for (const m of tradingMarkets(ev)) {
            if (s.drop?.some((re) => re.test(m.label))) continue;
            const written = edges?.[m.label];
            expect(written, `${u}: "${m.label}" has edges`).toBeDefined();
            const parsed = parseLabel(m.label, b.labels);
            expect(parsed, `${u}: "${m.label}" parses`).not.toBeNull();
            expect(interval(parsed!, s.value)).toEqual(interval(rangeOfEdges(written!)!, s.value));
          }
        }
      }
    }
  });

  test('dated labels take the year from the market end, a few hours back (a 11:59 PM ET cutoff is the next day in UTC)', () => {
    expect(parseDateLabel('November 15', '2026-11-16T04:59:00Z')).toEqual({ y: 2026, m: 11, d: 15 });
    expect(parseDateLabel('December 31', '2027-01-01T04:59:00Z')).toEqual({ y: 2026, m: 12, d: 31 });
    expect(parseDateLabel('October 31, 2026', null)).toEqual({ y: 2026, m: 10, d: 31 });
    expect(parseDateLabel('Nov 2', '2026-11-03T04:59:00Z')).toEqual({ y: 2026, m: 11, d: 2 });
    expect(parseDateLabel('Soon', null)).toBeNull();
  });
});

describe('fitting buckets inside their spreads', () => {
  const b = (bid: number | null, ask: number | null) => ({ label: '', bid, ask, last: null, range: { kind: 'exact' as const, a: 0 } });

  test('tight books: about the normalised mids, summing to 1', () => {
    const f = fitBuckets([b(0.33, 0.34), b(0.32, 0.34), b(0.33, 0.35)]);
    expect(f.reduce((t, x) => t + x.p, 0)).toBeCloseTo(1, 12);
    for (const x of f) expect(x.p).toBeGreaterThanOrEqual(x.bid! - 1e-12);
  });

  test('wide books lean on the bids the rest of the book supports, where mids overstate (FED-2027, 2026-10-29)', async () => {
    const ev = await fixture('what-will-the-fed-rate-be-at-the-end-of-2027');
    const mids = tradingMarkets(ev).reduce((t, m) => t + ((m.bid ?? 0) + (m.ask ?? 0)) / 2, 0);
    expect(mids).toBeGreaterThan(1.6); // the mids alone add up to about 173%
    const f = fitBuckets(tradingMarkets(ev).map((m) => ({ label: m.label, bid: m.bid, ask: m.ask, last: m.last, range: { kind: 'exact' as const, a: 0 } })));
    expect(f.reduce((t, x) => t + x.p, 0)).toBeCloseTo(1, 12);
    for (const x of f) {
      expect(x.p).toBeGreaterThanOrEqual((x.bid ?? 0) - 1e-12);
      expect(x.p).toBeLessThanOrEqual((x.ask ?? 1) + 1e-12);
    }
  });

  test('a crossed book (bids alone over 100%) falls back to normalised mids', () => {
    const f = fitBuckets([b(0.6, 0.7), b(0.6, 0.7)]);
    expect(f.map((x) => x.p)).toEqual([0.5, 0.5]);
  });

  test('ladder points: the mid while tight, the last trade inside wider quotes, dropped when wider still or one-sided', () => {
    const pt = (x: number, bid: number | null, ask: number | null, last: number | null) => ({ label: String(x), x, bid, ask, last, survival: false });
    const f = fitPoints([pt(1, 0.2, 0.24, null), pt(2, 0.3, 0.45, 0.42), pt(3, 0.3, 0.45, 0.5), pt(4, 0.5, 0.75, 0.6), pt(5, 0.7, null, 0.9)]);
    expect(f.map((p) => [p.x, p.F])).toEqual([[1, expect.closeTo(0.22, 12)], [2, 0.42]]);
  });
});

describe('bucket events', () => {
  test('HOUSE-R-2026: Republican seats ≈ 196, with "Below 190" split by the lower-brackets event', async () => {
    const s = spec('HOUSE-R-2026');
    const src = s.sources[0] as PolymarketBuckets;
    const main = await fixture(src.slug);
    const v = viewPmBuckets(main, src, optionsOf('HOUSE-R-2026'), await fixture(src.refine!.slug));
    expect(v.dist.median()).toBeCloseTo(196.2, 0);
    expect(v.spread).toBeLessThan(THIN_SPREAD);
    // the split keeps the coarse bucket's total and gives it the finer event's shape
    const plain = viewPmBuckets(main, { ...src, refine: undefined }, optionsOf('HOUSE-R-2026'));
    expect(v.dist.below(189.5)).toBeCloseTo(plain.dist.below(189.5), 12);
    expect(v.dist.below(179.5)).not.toBeCloseTo(plain.dist.below(179.5), 3);
    expect(v.dist.below(150)).toBe(0);
  });

  test('SENATE-R-2026: Republican seats ≈ 48', async () => {
    const src = spec('SENATE-R-2026').sources[0] as PolymarketBuckets;
    const v = viewPmBuckets(await fixture(src.slug), src, optionsOf('SENATE-R-2026'), await fixture(src.refine!.slug));
    expect(v.dist.median()).toBeCloseTo(48.3, 1);
    // P(R ≥ 49) about 47%: the fair strike 48.5 is just under 50/50
    expect(v.dist.above(48.5)).toBeGreaterThan(0.42);
    expect(v.dist.above(48.5)).toBeLessThan(0.5);
  });

  test('HOUSE-VOTE-2026: the margin ≈ D+9.3; "Other" (inactive) is ignored; Republican buckets sit below zero', async () => {
    const src = spec('HOUSE-VOTE-2026').sources[0] as PolymarketBuckets;
    const v = viewPmBuckets(await fixture(src.slug), src, optionsOf('HOUSE-VOTE-2026'));
    expect(v.rows.map((r) => r.label)).not.toContain('Other');
    expect(v.dist.median()).toBeCloseTo(9.3, 1);
    expect(v.dist.below(0)).toBeGreaterThan(0.04);
    expect(v.dist.below(0)).toBeLessThan(0.07);
  });

  test('ANTH-IPO-CAP: "No IPO" is dropped (the market is void then) and the cap ≈ $1.93T', async () => {
    const src = spec('ANTH-IPO-CAP').sources[0] as PolymarketBuckets;
    const v = viewPmBuckets(await fixture(src.slug), src, optionsOf('ANTH-IPO-CAP'));
    expect(v.rows.map((r) => r.label).some((l) => /no ipo/i.test(l))).toBe(false);
    expect(v.rows.reduce((t, r) => t + r.p, 0)).toBeCloseTo(1, 12);
    expect(v.dist.median()).toBeGreaterThan(1920);
    expect(v.dist.median()).toBeLessThan(1945);
  });

  test('FED-2027: discrete levels, median 4.5%, and a thin book (quoted wider)', async () => {
    const src = spec('FED-2027').sources[0] as PolymarketBuckets;
    const v = viewPmBuckets(await fixture(src.slug), src, optionsOf('FED-2027'));
    expect(v.dist.segments).toEqual([]);
    expect(v.dist.atoms.every(([x]) => Math.abs(x * 4 - Math.round(x * 4)) < 1e-9)).toBe(true);
    expect(v.dist.median()).toBe(4.5);
    expect(v.spread).toBeGreaterThan(THIN_SPREAD);
  });

  test('a bucket it can neither find in the table nor read stops the market', async () => {
    const ev = await fixture('republican-house-seats-after-the-2026-midterm-elections');
    ev.markets[0] = { ...ev.markets[0], label: 'Some other bracket' };
    const src = spec('HOUSE-R-2026').sources[0] as PolymarketBuckets;
    expect(() => viewPmBuckets(ev, { ...src, refine: undefined }, optionsOf('HOUSE-R-2026'))).toThrow(Unreadable);
  });
});

describe('ladders of thresholds', () => {
  test('PREDICT-FDV: "FDV above $X" read as a survival curve, conditional on a launch, median ≈ $1.25B', async () => {
    const src = spec('PREDICT-FDV').sources[0] as PolymarketLadder;
    const ev = await fixture(src.slug);
    const v = viewPmLadder(ev, src, optionsOf('PREDICT-FDV'));
    expect(v.dist.median()).toBeCloseTo(1.257, 2);
    // conditional: nothing under the lowest threshold, $50M
    expect(v.dist.below(0.05)).toBeCloseTo(0, 9);
    const unconditional = viewPmLadder(ev, src, { ...optionsOf('PREDICT-FDV'), conditional: false });
    expect(unconditional.dist.below(0.05)).toBeGreaterThan(0);
    expect(unconditional.dist.median()).toBeLessThan(v.dist.median());
  });
});

describe('dated ladders', () => {
  const dates = (u: string) => {
    const s = CATALOG[u].spec;
    if (s.model !== 'date') throw new Error(`${u} is not a date market`);
    return { src: s.sources[0] as DateSource, zone: s.zone, deadline: jdnOf(offlineListings(CATALOG[u])[0].deadline!) };
  };
  const dayOf = (axis: number) => Math.round(axis);

  test('ANTH-IPO-DATE: "IPO by" (ET dates on an ET calendar), median Nov 20; past and resolved dates are ignored', async () => {
    const { src, zone, deadline } = dates('ANTH-IPO-DATE');
    const v = viewPmDates(await fixture(src.slug), src, { zone, now: NOW, deadline });
    expect(dayOf(v.dist.median())).toBe(jdnOfDay(2026, 11, 20));
    // P(by Nov 19, ET) is the venue's own price for Nov 19: 42%
    expect(v.dist.below(jdnOfDay(2026, 11, 19) + 0.5)).toBeCloseTo(0.42, 2);
    // "no IPO by Dec 31" (5%) is a point mass on the deadline
    expect(v.dist.atoms.at(-1)![0]).toBe(deadline);
    expect(v.dist.atoms.at(-1)![1]).toBeCloseTo(0.052, 2);
    // nothing before now: it hasn't happened
    expect(v.dist.below(jdnOf(NOW) - 0.5)).toBe(0);
  });

  test('FABLE-NEXT: median Nov 10', async () => {
    const { src, zone, deadline } = dates('FABLE-NEXT');
    const v = viewPmDates(await fixture(src.slug), src, { zone, now: NOW, deadline });
    expect(dayOf(v.dist.median())).toBe(jdnOfDay(2026, 11, 10));
  });

  test('IRAN-STRIKE: "the ceasefire continues through" is survival, at 11:59 PM Iran time, on a UTC calendar', async () => {
    const { src, zone, deadline } = dates('IRAN-STRIKE');
    const v = viewPmDates(await fixture(src.slug), src, { zone, now: NOW, deadline });
    const median = dayOf(v.dist.median());
    expect(median).toBeGreaterThanOrEqual(jdnOfDay(2026, 11, 19));
    expect(median).toBeLessThanOrEqual(jdnOfDay(2026, 11, 20));
    // through Nov 15 at 58.5¢: P(strike before Nov 15 20:30 UTC) = 41.5%, a little less by the UTC midnight before
    expect(v.dist.below(jdnOfDay(2026, 11, 15) + 0.5 - 3.5 / 24)).toBeCloseTo(0.415, 2);
    expect(v.dist.atoms.at(-1)![1]).toBeGreaterThan(0.27);
  });
});
