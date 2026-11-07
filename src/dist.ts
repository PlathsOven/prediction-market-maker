// A distribution of a market's number, in the market's own units: point masses (atoms) plus pieces of uniform
// density (segments). Its CDF is piecewise linear with jumps, which covers everything the sources give:
//
//   a bucket ("210-214 seats", 13%)        a segment: 13% spread evenly over [209.5, 214.5)
//   a CDF read at points ("by Nov 20", 61%)  segments between consecutive points, each with the CDF's rise
//   a discrete outcome (the Fed at 4.25%)   an atom
//   a deadline ("not by Dec 31")             an atom at the deadline
//
// Integer quantities (seats, posts, days) put the value v on [v - 0.5, v + 0.5), so at the half-unit strikes they
// trade on the piecewise-linear CDF is exact.

export interface Segment {
  lo: number;
  hi: number;
  /** Probability, spread evenly over [lo, hi). */
  p: number;
}

export type Atom = readonly [x: number, p: number];

const EPS = 1e-12;

export class Dist {
  readonly atoms: readonly Atom[];
  readonly segments: readonly Segment[];

  /** Normalises the total to 1 (throws when there's nothing to normalise). */
  constructor(atoms: readonly Atom[], segments: readonly Segment[]) {
    const a = atoms.filter(([x, p]) => p > 0 && Number.isFinite(x) && Number.isFinite(p));
    const s: Segment[] = [];
    for (const g of segments) {
      if (!(g.p > 0) || !Number.isFinite(g.lo) || !Number.isFinite(g.hi)) continue;
      // a segment with no width is an atom
      if (g.hi - g.lo < 1e-12) a.push([g.lo, g.p]);
      else s.push({ ...g });
    }
    const total = a.reduce((t, [, p]) => t + p, 0) + s.reduce((t, g) => t + g.p, 0);
    if (!(total > 0)) throw new Error('empty distribution');
    this.atoms = merge(a.map(([x, p]) => [x, p / total] as const));
    this.segments = s.map((g) => ({ ...g, p: g.p / total })).sort((x, y) => x.lo - y.lo);
  }

  /** P(X < k): what a taker who sells into a bid at k (and so holds Lower) wins with. */
  below(k: number): number {
    let t = 0;
    for (const [x, p] of this.atoms) if (x < k) t += p;
    for (const g of this.segments) t += g.p * clamp01((k - g.lo) / (g.hi - g.lo));
    return Math.min(1, t);
  }

  /** P(X > k): what a taker who buys from an ask at k (and so holds Higher) wins with. */
  above(k: number): number {
    let t = 0;
    for (const [x, p] of this.atoms) if (x > k) t += p;
    for (const g of this.segments) t += g.p * clamp01((g.hi - k) / (g.hi - g.lo));
    return Math.min(1, t);
  }

  /** P(X ≤ x). */
  cdf(x: number): number {
    return 1 - this.above(x);
  }

  /** The smallest x with P(X ≤ x) ≥ q (between breakpoints the CDF is linear, so this is exact). */
  quantile(q: number): number {
    const points = this.breakpoints();
    let prevX = points[0];
    let prevF = this.cdf(prevX);
    if (prevF >= q - EPS) return prevX;
    for (const x of points.slice(1)) {
      const left = this.below(x);
      if (left >= q - EPS) return prevX + ((x - prevX) * (q - prevF)) / Math.max(EPS, left - prevF);
      const f = this.cdf(x);
      if (f >= q - EPS) return x; // the jump of an atom at x
      prevX = x;
      prevF = f;
    }
    return prevX;
  }

  median(): number {
    return this.quantile(0.5);
  }

  /** The smallest and largest values with any probability. */
  support(): [number, number] {
    const xs = this.breakpoints();
    return [xs[0], xs[xs.length - 1]];
  }

  /** The distribution given X ≥ lo (renormalised): what's left once a floor is known. */
  truncate(lo: number): Dist {
    const atoms = this.atoms.filter(([x]) => x >= lo);
    const segments = this.segments.flatMap((g) => {
      const a = Math.max(g.lo, lo);
      return g.hi > a ? [{ lo: a, hi: g.hi, p: (g.p * (g.hi - a)) / (g.hi - g.lo) }] : [];
    });
    return new Dist(atoms, segments);
  }

  /** Every value above x moved to x: a deadline, where "not yet" settles at the deadline. */
  capAt(x: number): Dist {
    const atoms: Atom[] = this.atoms.map(([v, p]) => [Math.min(v, x), p]);
    const segments: Segment[] = [];
    for (const g of this.segments) {
      if (g.lo >= x) atoms.push([x, g.p]);
      else if (g.hi <= x) segments.push(g);
      else {
        const share = (x - g.lo) / (g.hi - g.lo);
        segments.push({ lo: g.lo, hi: x, p: g.p * share });
        atoms.push([x, g.p * (1 - share)]);
      }
    }
    return new Dist(atoms, segments);
  }

  /** The same distribution moved by c: a count to come plus the count so far. */
  shift(c: number): Dist {
    return new Dist(
      this.atoms.map(([x, p]) => [x + c, p] as const),
      this.segments.map((g) => ({ lo: g.lo + c, hi: g.hi + c, p: g.p })),
    );
  }

  /** The same distribution times f > 0: a count's forecast at another pace. */
  scale(f: number): Dist {
    return new Dist(
      this.atoms.map(([x, p]) => [x * f, p] as const),
      this.segments.map((g) => ({ lo: g.lo * f, hi: g.hi * f, p: g.p })),
    );
  }

  /** A mixture: each distribution with its weight (weights needn't sum to 1). */
  static mix(parts: readonly (readonly [Dist, number])[]): Dist {
    const atoms: Atom[] = [];
    const segments: Segment[] = [];
    for (const [d, w] of parts) {
      if (!(w > 0)) continue;
      for (const [x, p] of d.atoms) atoms.push([x, p * w]);
      for (const g of d.segments) segments.push({ ...g, p: g.p * w });
    }
    return new Dist(atoms, segments);
  }

  /** The distribution whose CDF passes through these points (x ascending, F non-decreasing), linear between them. */
  static fromCdf(points: readonly (readonly [x: number, F: number])[]): Dist {
    const segments: Segment[] = [];
    const atoms: Atom[] = [];
    let [x0, f0] = points[0] ?? [0, 0];
    if (f0 > 0) atoms.push([x0, f0]);
    for (const [x, f] of points.slice(1)) {
      if (f > f0) {
        if (x > x0) segments.push({ lo: x0, hi: x, p: f - f0 });
        else atoms.push([x, f - f0]);
      }
      x0 = x;
      f0 = Math.max(f0, f);
    }
    if (f0 < 1 - 1e-9) atoms.push([x0, 1 - f0]);
    return new Dist(atoms, segments);
  }

  private breakpoints(): number[] {
    const xs = new Set<number>();
    for (const [x] of this.atoms) xs.add(x);
    for (const g of this.segments) {
      xs.add(g.lo);
      xs.add(g.hi);
    }
    return [...xs].sort((a, b) => a - b);
  }
}

function clamp01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

/** Atoms at the same value, added up, ascending. */
function merge(atoms: readonly Atom[]): Atom[] {
  const by = new Map<number, number>();
  for (const [x, p] of atoms) by.set(x, (by.get(x) ?? 0) + p);
  return [...by.entries()].sort((a, b) => a[0] - b[0]);
}

// ---- the normal distribution --------------------------------------------------------------------------------

/** Φ, the standard normal CDF (Abramowitz & Stegun 7.1.26: error under 1.5e-7). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Φ⁻¹, by bisection on Φ (to about 1e-9). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A normal distribution as CDF knots, ±3 sd (a prior, or a shape through one price). */
export const normalKnots = (mean: number, sd: number): [number, number][] =>
  (
    [[-3, 0.00135], [-2, 0.02275], [-1.5, 0.06681], [-1, 0.15866], [-0.5, 0.30854], [0, 0.5], [0.5, 0.69146], [1, 0.84134], [1.5, 0.93319], [2, 0.97725], [3, 0.99865]] as const
  ).map(([z, p]) => [mean + z * sd, p]);

// ---- monotone fits ------------------------------------------------------------------------------------------

/**
 * The closest non-decreasing sequence to ys in weighted least squares (pool adjacent violators): a CDF read at
 * dates or thresholds whose prices cross (Nov 23 above Nov 24) comes out monotone, the tighter quotes winning.
 */
export function isotonic(ys: readonly number[], ws: readonly number[] = ys.map(() => 1)): number[] {
  const blocks: { y: number; w: number; n: number }[] = [];
  for (let i = 0; i < ys.length; i++) {
    blocks.push({ y: ys[i], w: ws[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].y > blocks[blocks.length - 1].y) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      const w = a.w + b.w;
      blocks.push({ y: (a.y * a.w + b.y * b.w) / w, w, n: a.n + b.n });
    }
  }
  return blocks.flatMap((b) => Array<number>(b.n).fill(b.y));
}
