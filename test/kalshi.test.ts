// The Kalshi readers on responses recorded from its public API on 2026-10-29 at about 09:00 UTC.
import { describe, expect, test } from 'bun:test';
import { viewKalshi } from '../src/analogs.ts';
import { CATALOG } from '../src/markets.ts';
import { Unreadable } from '../src/models/model.ts';
import { kalshiRange, parseKsEvent } from '../src/sources/kalshi.ts';

const fixture = async (ticker: string) => parseKsEvent(JSON.parse(await Bun.file(`${import.meta.dir}/fixtures/kalshi-${ticker}.json`).text()));
const options = (u: string) => {
  const s = CATALOG[u].spec;
  if (s.model !== 'event') throw new Error(u);
  return { value: s.value, support: s.support };
};

describe('Kalshi', () => {
  test('structured strikes, no text: between, less, greater and their or-equal forms', () => {
    expect(kalshiRange('between', 193, 197)).toEqual({ kind: 'range', a: 193, b: 197 });
    expect(kalshiRange('between', 45, 45)).toEqual({ kind: 'exact', a: 45 });
    expect(kalshiRange('less', null, 193)).toEqual({ kind: 'below', a: 193 });
    expect(kalshiRange('less_or_equal', 0, 44)).toEqual({ kind: 'atMost', a: 44 });
    expect(kalshiRange('greater', 237, null)).toEqual({ kind: 'above', a: 237 });
    expect(kalshiRange('greater_or_equal', 53, 100)).toEqual({ kind: 'atLeast', a: 53 });
    expect(kalshiRange('custom', null, null)).toBeNull();
  });

  test('an empty side reads as missing, not as a price of 0 or 1', async () => {
    const ev = await fixture('KXFED-27DEC');
    const above0 = ev.markets.find((m) => m.ticker === 'KXFED-27DEC-T0.00')!;
    expect(above0.ask).toBeNull();
    expect(above0.bid).toBe(0.64);
  });

  test('Republican House seats ≈ 196, and Democratic seats mirrored (435 − D) agree', async () => {
    const r = viewKalshi(await fixture('KXRHOUSESEATS-27'), { venue: 'kalshi', event: 'KXRHOUSESEATS-27' }, options('HOUSE-R-2026'));
    const d = viewKalshi(await fixture('KXDHOUSESEATS-27'), { venue: 'kalshi', event: 'KXDHOUSESEATS-27', mirror: 435 }, options('HOUSE-R-2026'));
    expect(r.dist.median()).toBeCloseTo(196, 0);
    expect(d.dist.median()).toBeCloseTo(196, 0);
    // "Above 249" Democratic seats is "185 or fewer" Republican ones: about 22%
    expect(d.dist.below(185.5)).toBeCloseTo(0.224, 2);
  });

  test('Senate seats: R ≈ 48.3 from both events', async () => {
    const r = viewKalshi(await fixture('RSENATESEATS-27'), { venue: 'kalshi', event: 'RSENATESEATS-27' }, options('SENATE-R-2026'));
    const d = viewKalshi(await fixture('KXDSENATESEATS-27'), { venue: 'kalshi', event: 'KXDSENATESEATS-27', mirror: 100 }, options('SENATE-R-2026'));
    expect(r.dist.median()).toBeCloseTo(48.3, 1);
    expect(d.dist.median()).toBeCloseTo(48.2, 1);
  });

  test('the House vote margin ≈ D+9.45; "Republicans win" spreads over the support below zero', async () => {
    const v = viewKalshi(await fixture('KXHOUSEPOPVOTEMARGIN-27NOV03'), { venue: 'kalshi', event: 'KXHOUSEPOPVOTEMARGIN-27NOV03' }, options('HOUSE-VOTE-2026'));
    expect(v.dist.median()).toBeCloseTo(9.45, 1);
    expect(v.dist.below(0)).toBeCloseTo(0.052, 2);
    expect(v.dist.below(-15)).toBe(0);
  });

  test('a ladder quoted over 10¢ wide everywhere (KXFED-27DEC on 2026-10-29) is unusable, not misread', async () => {
    expect(() => viewKalshi(fixtureSync, { venue: 'kalshi', event: 'KXFED-27DEC' }, options('FED-2027'))).toThrow(Unreadable);
  });
});

const fixtureSync = parseKsEvent(JSON.parse(await Bun.file(`${import.meta.dir}/fixtures/kalshi-KXFED-27DEC.json`).text()));
