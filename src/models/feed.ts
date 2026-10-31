// Feed markets: the number is a live price Rizon reads from the source itself (Coinbase and Kraken for BTC,
// PAXG for gold) and streams on its price:<underlying> channel. There's nothing to infer: the bot quotes around
// that price with the market's realised volatility (GET /markets sigma), re-quoting as it moves. While the price
// is down (simulated, or no new one for a few seconds) the book is held as it is: the exchange takes no orders
// on it meanwhile, so the quotes can't be traded, and they're there the moment it's back.
import type { Market } from '../api.ts';
import type { Grid } from '../grid.ts';
import type { Quote } from '../ladder.ts';
import { hold, strikesOf, none, type Model, type Target, type Tick } from './model.ts';

/** A feed book's ladder from spot, the market's sigma over its horizon, the horizon (s) and the strikes it takes. */
export type FeedLadder = (spot: number, sigma: number, horizon: number, g: Grid) => Quote[];

export class FeedModel implements Model {
  readonly source: string;
  readonly follows = true;

  /**
   * quoteWhenNotLive: keep re-quoting while Rizon's value is simulated or stale. Neither BTC nor Gold does: the
   * exchange takes no orders while a price is simulated (contracts that expire then are pushed), and a stale index
   * next to a live price elsewhere is free money for whoever reads the live one. They hold their book instead.
   */
  /** maxAgeMs: hold the book once the last price is older than this (the exchange refuses orders soon after). */
  constructor(
    private readonly ladder: FeedLadder,
    private readonly quoteWhenNotLive: boolean,
    name = 'price feed',
    private readonly maxAgeMs?: number,
  ) {
    this.source = name;
  }

  target(m: Market, now: number, last?: Tick): Target {
    const spot = last?.price ?? m.spot;
    if (spot === null || spot === undefined) return none('no price yet');
    // not live if either the listing (every 5 s) or the last price says so
    const live = m.live && (last?.live ?? true);
    if (!live && !this.quoteWhenNotLive) return hold('price not live', spot);
    if (this.maxAgeMs !== undefined && last && now - last.at > this.maxAgeMs) return hold(`no new price for ${Math.round((now - last.at) / 1000)} s`, spot);
    if (m.horizon === null) return none('not a rolling market', spot);
    return { quotes: this.ladder(spot, m.sigma, m.horizon, strikesOf(m, now)), center: spot };
  }
}
