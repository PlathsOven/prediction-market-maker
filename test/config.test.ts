import { expect, test } from 'bun:test';
import type { Market } from '../src/api.ts';
import { allowList, config } from '../src/config.ts';

const m = (id: string, underlying: string) => ({ id, underlying }) as Market;

test('MARKETS: market ids, underlying ids and prefixes, in any case; an entry starting with ! leaves those out', () => {
  expect(allowList('')(m('BTC-15s', 'BTC-USD'))).toBe(true);
  const gold = allowList('PAXG-USD');
  expect(gold(m('GOLD-15s', 'PAXG-USD'))).toBe(true);
  expect(gold(m('BTC-15s', 'BTC-USD'))).toBe(false);
  const rest = allowList('!PAXG-USD');
  expect(rest(m('GOLD-15s', 'PAXG-USD'))).toBe(false);
  expect(rest(m('HOUSE-R-2026', 'HOUSE-R-2026'))).toBe(true);
  const some = allowList('elon-*, btc-15s, !ELON-7d');
  expect(some(m('ELON-1d', 'ELON-POSTS'))).toBe(true);
  expect(some(m('ELON-7d', 'ELON-POSTS'))).toBe(false);
  expect(some(m('BTC-15s', 'BTC-USD'))).toBe(true);
  expect(some(m('BTC-1m', 'BTC-USD'))).toBe(false);
});

test('a user key quotes $2 a level everywhere; the house (BOT_KEY) its full sizes', () => {
  const user = config({ RIZON_KEY: 'rz_x' });
  expect(user.sizing.ladder.sizes).toEqual([2]);
  expect(user.feed?.size).toBe(2);
  const house = config({ BOT_KEY: 'k', RIZON_URL: 'http://localhost:8080/' });
  expect(house.house).toBe(true);
  expect(house.feed).toBeUndefined();
  expect(house.sizing.ladder.sizes).toEqual([500]);
  expect(house.url).toBe('http://localhost:8080');
});

test("a feed book's calibration gives way only to what's set: unset LEVELS or SIZE keeps the calibrated one", () => {
  expect(config({ RIZON_KEY: 'rz_x' }).feed).toEqual({ size: 2 });
  expect(config({ RIZON_KEY: 'rz_x', LEVELS: '4' }).feed).toEqual({ size: 2, levels: 4 });
  expect(config({ BOT_KEY: 'k', LEVELS: '5' }).feed).toEqual({ levels: 5 });
  expect(config({ BOT_KEY: 'k', SIZE: '50' }).feed).toEqual({ size: 50 });
});
