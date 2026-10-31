// Treasury and FRED, XTracker and the two status pages, and the models built on them, on responses recorded on
// 2026-10-29 at about 09:00 UTC.
import { describe, expect, test } from 'bun:test';
import { normCdf } from '../src/dist.ts';
import { viewCountBuckets, windowFor } from '../src/models/elon.ts';
import { uptimeDist, windowUptimes } from '../src/models/uptime.ts';
import { viewMaxYield } from '../src/models/ust10y.ts';
import { parsePmEvent } from '../src/sources/polymarket.ts';
import { PARTIAL_WEIGHT, outageDays, parseAtlassianStatus, parseInstatusHome, parseInstatusStatus, parseShowcase } from '../src/sources/statuspage.ts';
import { mergeCloses, parseFredCsv, parseTreasuryCsv } from '../src/sources/treasury.ts';
import { parseStats, parseTrackings } from '../src/sources/xtracker.ts';

const F = `${import.meta.dir}/fixtures`;
const text = (f: string) => Bun.file(`${F}/${f}`).text();
const json = async (f: string) => JSON.parse(await text(f));
const NOW = Date.parse('2026-10-29T09:00:00Z');

describe('the 10-year yield', () => {
  test('Treasury CSV (newest first, MM/DD/YYYY) and FRED CSV, oldest first; Treasury wins a shared day', async () => {
    const t = parseTreasuryCsv(await text('treasury-2026.csv'));
    expect(t.at(-1)).toEqual({ day: '2026-10-28', value: 5.05 });
    expect(t.find((c) => c.day === '2026-10-05')?.value).toBe(5.31);
    expect(t.every((c, i) => i === 0 || c.day > t[i - 1].day)).toBe(true);
    const f = parseFredCsv(await text('fred-dgs10.csv'));
    expect(f.at(-1)).toEqual({ day: '2026-10-27', value: 4.99 });
    const merged = mergeCloses([{ day: '2026-10-27', value: 5 }], f);
    expect(merged.find((c) => c.day === '2026-10-27')?.value).toBe(5);
  });

  test('UST10Y-MAX-2026: the hit ladder, the reflection principle under 5.3%, median ≈ 5.25%', async () => {
    const ev = parsePmEvent(await json('polymarket-how-high-will-10-year-treasury-yield-go-before-2027.json'));
    const closes = parseTreasuryCsv(await text('treasury-2026.csv'));
    const v = viewMaxYield(ev, closes, { from: '2026-10-29', to: '2026-12-31', cap: 7.5, now: NOW });
    // only the open "5.3%" counts (an older one resolved yes); it says P(M ≥ 5.3) = 41%
    expect(v.rows.map((r) => r.label)).toEqual(['5.3%', '5.4%', '5.5%', '5.7%', '6.0%']);
    expect(v.dist.above(5.3)).toBeCloseTo(0.41, 2);
    // under it, a driftless walk from 5.05 that reaches 5.3 with 41%: P(M ≥ x) = 2(1 − Φ((x − 5.05)/s))
    const s = 0.25 / 0.824;
    expect(v.dist.above(5.2)).toBeCloseTo(2 * (1 - normCdf(0.15 / s)), 2);
    expect(v.dist.median()).toBeCloseTo(5.255, 2);
    expect(v.note).toContain('window high none yet');
  });

  test('once the window has a higher close than today, the chance of never getting back to it is a point mass on it', async () => {
    const ev = parsePmEvent(await json('polymarket-how-high-will-10-year-treasury-yield-go-before-2027.json'));
    const closes = [...parseTreasuryCsv(await text('treasury-2026.csv')), { day: '2026-10-29', value: 5.2 }, { day: '2026-10-30', value: 5.1 }];
    const v = viewMaxYield(ev, closes, { from: '2026-10-29', to: '2026-12-31', cap: 7.5, now: NOW });
    expect(v.dist.below(5.2)).toBe(0);
    const [x, p] = v.dist.atoms[0];
    expect(x).toBe(5.2);
    expect(p).toBeGreaterThan(0.1);
  });
});

describe('XTracker and Polymarket\'s Elon windows (the ELON books\' check)', () => {
  test('trackings carry their window and their Polymarket event; a window\'s stats its count so far', async () => {
    const list = parseTrackings(await json('xtracker-user.json'));
    const week = list.find((t) => t.slug === 'elon-musk-of-tweets-october-30-november-6-2026');
    // it ends after the clocks change: noon ET is 17:00 UTC (XTracker stops a second before)
    expect(week && [new Date(week.start).toISOString(), new Date(week.end).toISOString()]).toEqual(['2026-10-30T16:00:00.000Z', '2026-11-06T16:59:59.000Z']);
    expect(parseStats(await json('xtracker-tracking-1023.json')).total).toBe(282);
  });

  test('the window to check against: open, at least half the horizon left, its time left nearest the horizon', async () => {
    const list = parseTrackings(await json('xtracker-user.json'));
    const at = Date.parse('2026-10-31T08:00:00Z');
    // a week: the Friday-to-Friday window (6.4 days left) over the Tuesday one (3.3 days, under half a week)
    expect(windowFor(list, at, 7 * 86_400_000)?.slug).toBe('elon-musk-of-tweets-october-30-november-6-2026');
    // a day: October's window (20 hours left) over the weeks; not the two-day one ending in 8 hours
    expect(windowFor(list, at, 86_400_000)?.slug).toBe('elon-musk-of-tweets-october-2026');
    // a window that hasn't started isn't open
    expect(windowFor(list, Date.parse('2026-10-30T15:00:00Z'), 7 * 86_400_000)?.slug).toBe('elon-musk-of-tweets-october-27-november-3-2026');
  });

  test('a window\'s buckets with the count so far (282) as a floor: median ≈ 338', async () => {
    const ev = parsePmEvent(await json('polymarket-elon-musk-of-tweets-october-23-october-30-2026.json'));
    const v = viewCountBuckets(ev, 282, [0, 10_000]);
    expect(v.dist.below(281.5)).toBe(0);
    expect(v.dist.median()).toBeCloseTo(338, 0);
    // buckets that resolved No (under the count) aren't read at all
    expect(v.rows[0].label).toBe('280-299');
  });

  test('the week after (no posts counted yet): median ≈ 312', async () => {
    const ev = parsePmEvent(await json('polymarket-elon-musk-of-tweets-october-30-november-6-2026.json'));
    expect(viewCountBuckets(ev, 0, [0, 10_000]).dist.median()).toBeCloseTo(312, 0);
  });
});

describe('status pages and the uptime markets', () => {
  test('Atlassian: 90 days of outage seconds, partial counted at 0.3; the component status now', async () => {
    const days = parseShowcase(await json('statuspage-claude-showcase.json'), 'rwppv331jlwc');
    expect(days).toHaveLength(90);
    expect(days.find((d) => d.day === '2026-10-27')?.down).toBeCloseTo(PARTIAL_WEIGHT * 3884, 6);
    expect(days.find((d) => d.day === '2026-10-23')?.down).toBe(992);
    expect(parseAtlassianStatus(await json('statuspage-claude-components.json'), 'rwppv331jlwc')).toBe('up');
    // the formula reproduces the page's own 30-day figure (99.81%)
    const last30 = days.filter((d) => d.day >= '2026-09-29' && d.day <= '2026-10-28');
    expect(100 * (1 - last30.reduce((t, d) => t + d.down, 0) / (30 * 86_400))).toBeCloseTo(99.81, 2);
  });

  test('claude.ai: every 7-day window of whole days (today left out), a point mass at 100%, median ≈ 99.77%', async () => {
    const days = parseShowcase(await json('statuspage-claude-showcase.json'), 'rwppv331jlwc');
    const samples = windowUptimes(days, 7, '2026-10-29').map((s) => s.u);
    expect(samples).toHaveLength(89 - 6);
    const d = uptimeDist(samples.map((u) => ({ u })));
    expect(d.atoms.at(-1)).toEqual([100, expect.closeTo(samples.filter((u) => u === 100).length / samples.length, 12)]);
    expect(d.median()).toBeGreaterThan(99.7);
    expect(d.median()).toBeLessThan(99.85);
  });

  test('Instatus: the outages from the page\'s embedded data; overlapping intervals count once, at the heavier weight', async () => {
    const home = parseInstatusHome(await text('instatus-poly-home.html'), 'cljg99p53207029broc36bdpn0h');
    expect(new Date(home.from).toISOString().slice(0, 10)).toBe('2026-07-31');
    expect(home.outages.filter((o) => o.status === 'MAJOROUTAGE')).toHaveLength(20);
    expect(parseInstatusStatus(await json('instatus-poly-components.json'), 'cljg99p53207029broc36bdpn0h')).toBe('up');
    const day = Date.parse('2026-09-01T00:00:00Z');
    const days = outageDays(
      [
        { from: day + 3_600_000, to: day + 2 * 3_600_000, status: 'PARTIALOUTAGE' },
        { from: day + 1.5 * 3_600_000, to: day + 2.5 * 3_600_000, status: 'MAJOROUTAGE' },
        { from: day + 23 * 3_600_000, to: day + 25 * 3_600_000, status: 'MAJOROUTAGE' },
        { from: day + 5 * 3_600_000, to: day + 6 * 3_600_000, status: 'UNDERMAINTENANCE' },
      ],
      day,
      day + 2 * 86_400_000 - 1,
    );
    // day 1: 0.5 h partial, 1 h major (the overlap at major), 1 h major before midnight; day 2: 1 h major after it
    expect(days[0]).toEqual({ day: '2026-09-01', down: 0.3 * 1800 + 3600 + 3600 });
    expect(days[1]).toEqual({ day: '2026-09-02', down: 3600 });
  });

  test('Polymarket\'s CLOB: its 90-day figure (99.16%) is reproduced from the intervals', async () => {
    const home = parseInstatusHome(await text('instatus-poly-home.html'), 'cljg99p53207029broc36bdpn0h');
    const days = outageDays(home.outages, home.from, home.to);
    const down = days.reduce((t, d) => t + d.down, 0);
    expect(100 * (1 - down / (days.length * 86_400))).toBeCloseTo(99.16, 1);
    const d = uptimeDist(windowUptimes(days, 7, '2026-10-29').map((s) => ({ u: s.u })));
    expect(d.atoms.at(-1)![0]).toBe(100);
    expect(d.atoms.at(-1)![1]).toBeGreaterThan(0.3);
  });
});
