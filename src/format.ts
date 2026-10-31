// Writing a market's numbers for logs: $79,838.94 · 196.5 seats · D+9.35 · Nov 20, 2026 · $1.93T · 99.78%.
import { dayOfJdn } from './grid.ts';

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A JDN as "Nov 20, 2026". */
export function dayLabel(jdn: number): string {
  const [y, m, d] = dayOfJdn(jdn).split('-').map(Number);
  return `${MONTH[m - 1]} ${d}, ${y}`;
}

const round = (v: number, digits: number) => Number(v.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });

/** A value (a median, a settle price) in its unit. */
export function fmtValue(unit: string | undefined, v: number): string {
  switch (unit) {
    case 'usd':
      return `$${round(v, 2)}`;
    case 'date':
      return dayLabel(Math.round(v));
    case 'usdbn':
      return v >= 1000 ? `$${round(v / 1000, 3)}T` : `$${round(v, 3)}B`;
    case 'pct':
    case 'uptime':
      return `${round(v, 3)}%`;
    case 'margin':
      return v >= 0 ? `D+${round(v, 2)}` : `R+${round(-v, 2)}`;
    default:
      return round(v, 2);
  }
}

/**
 * A strike in its unit. A date strike is a midnight, written as the day it starts: 2,461,365.5 is "Nov 21" (Higher
 * there: on Nov 21 or later; Lower: by Nov 20).
 */
export function fmtStrike(unit: string | undefined, k: number): string {
  if (unit === 'date') return `${dayLabel(k + 0.5)} (${k})`;
  return fmtValue(unit, k);
}
