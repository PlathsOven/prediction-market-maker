// The taker that picks off stale quotes: which quote it takes, and when it leaves the book alone.
import { describe, expect, test } from 'bun:test';
import { normalCdf, staleQuote } from '../src/sharp.ts';

describe('staleQuote', () => {
  test('the normal CDF', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.841345, 5);
    expect(normalCdf(-1.96)).toBeCloseTo(0.024998, 5);
  });

  test('a book around the price is left alone', () => {
    expect(staleQuote(100, 10, 99, 101, 0.06)).toBeNull();
  });

  test('a price that has run past the ask buys it: the chance of finishing above it is over half', () => {
    const take = staleQuote(105, 10, 99, 101, 0.06)!;
    expect(take).toMatchObject({ side: 'up', strike: 101 });
    // 4 past the strike at a sigma of 10: Φ(0.4) = 65.5%, so 31¢ per $1
    expect(take.edge).toBeCloseTo(0.3108, 3);
  });

  test('a price that has fallen through the bid sells it', () => {
    expect(staleQuote(95, 10, 99, 101, 0.06)).toMatchObject({ side: 'down', strike: 99 });
  });

  test('a move too small for the edge asked for, a missing side and an unknown sigma: nothing', () => {
    expect(staleQuote(101.1, 10, 99, 101, 0.06)).toBeNull();
    expect(staleQuote(105, 10, 99, null, 0.06)).toBeNull();
    expect(staleQuote(105, 0, 99, 101, 0.06)).toBeNull();
  });
});
