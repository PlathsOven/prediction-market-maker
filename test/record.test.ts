// The public record's rules: which side each takes on the last minute's move.
import { describe, expect, test } from 'bun:test';
import { RULES } from '../src/record.ts';

describe('the rules', () => {
  test('momentum follows the last minute’s move and reversal fades it, flat counting as up', () => {
    expect(RULES['MOMENTUM-BOT'](101, 100)).toBe('up');
    expect(RULES['MOMENTUM-BOT'](99, 100)).toBe('down');
    expect(RULES['MOMENTUM-BOT'](100, 100)).toBe('up');
    expect(RULES['REVERSAL-BOT'](101, 100)).toBe('down');
    expect(RULES['REVERSAL-BOT'](99, 100)).toBe('up');
  });

  test('the coin flip takes both sides, ignoring the price', () => {
    const sides = new Set(Array.from({ length: 200 }, () => RULES['COINFLIP-BOT'](100, 100)));
    expect(sides).toEqual(new Set(['up', 'down']));
  });
});
