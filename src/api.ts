// The parts of Rizon's public API (https://rizon.markets/docs) these bots use, written out here rather than
// imported: the bots talk to Rizon only through the API, like anyone's code. Money is paper USD, times are the
// server's milliseconds, strikes sit on each market's grid.

export type Side = 'up' | 'down';

/** How a market's number is written. Date markets carry Julian Day Numbers; margins are signed points. */
export type Unit = 'usd' | 'count' | 'seats' | 'pct' | 'date' | 'usdbn' | 'uptime' | 'margin';

export interface Market {
  /** BTC-15s, HOUSE-R-2026, ELON-1d */
  id: string;
  /** BTC-USD, HOUSE-R-2026, ELON-POSTS */
  underlying: string;
  /** Seconds from a fill to its expiry, on a rolling market; null on the others. */
  horizon: number | null;
  /** Strikes are strikeOffset + n × strikeStep. */
  strikeStep: number;
  strikeOffset: number;
  spot: number | null;
  /** false while the underlying's value is simulated or stale. */
  live: boolean;
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  /** The underlying's one-sigma move over the horizon, from its recent ticks, in its units. */
  sigma: number;
  // Fields an older server may not send yet; read them through the helpers below.
  kind?: 'rolling' | 'fixed' | 'date';
  expiresAt?: number | null;
  /** Date markets: a moment on the last day the event can happen on. */
  deadline?: number | null;
  closesAt?: number | null;
  status?: 'open' | 'closed' | 'halted' | 'resolved';
  unit?: Unit | string;
  name?: string;
  /** The lowest and highest strikes the market takes (date markets: tonight's midnight to the deadline's). */
  strikeMin?: number | null;
  strikeMax?: number | null;
}

export const kindOf = (m: Market): 'rolling' | 'fixed' | 'date' => m.kind ?? (m.horizon !== null ? 'rolling' : 'fixed');
export const isOpen = (m: Market): boolean => (m.status ?? 'open') === 'open';

export interface Order {
  id: string;
  clientId: string | null;
  market: string;
  side: Side;
  /** null: a market order. */
  strike: number | null;
  size: number;
  filled: number;
  status: 'open' | 'filled' | 'canceled';
  createdAt: number;
}

export interface Position {
  id: string;
  orderId: string | null;
  market: string;
  side: Side;
  strike: number;
  size: number;
  spot: number;
  openedAt: number;
  expiresAt: number;
  settlePrice: number | null;
  /** null while open. */
  result: 'win' | 'loss' | 'push' | null;
  pnl: number | null;
}

export interface Account {
  id: string;
  name: string;
  rank: number | null;
  pnl: number;
  balance: number;
  inOrders: number;
  inPositions: number;
  equity: number;
}

export interface OrderRequest {
  market: string;
  side: Side;
  size: number;
  strike?: number;
  tif?: 'gtc' | 'ioc' | 'post';
  clientId?: string;
}

export interface Placed {
  order: Order;
  positions: Position[];
  canceled: Order[];
}

export interface BatchResult {
  canceled: Order[];
  results: ({ status: number } & (Placed | { error: string }))[];
}

export interface Hello {
  t: number;
  account: Account | null;
  orders: Order[];
  positions: Position[];
  markets: Market[];
  channels: string[];
}

export interface Price {
  underlying: string;
  t: number;
  price: number;
  live: boolean;
}

export type ReqId = string | number | null;

/** What the WebSocket sends: always {type, data}; replies to requests add reqId and status. */
export type ServerMsg =
  | { type: 'hello'; data: Hello }
  | { type: 'price'; data: Price }
  | { type: 'order'; data: Order }
  | { type: 'position'; data: Position }
  | { type: 'account'; data: Account }
  /** Every market, whenever one opens, closes, halts or resolves (the markets channel). */
  | { type: 'markets'; data: Market[] }
  | { type: 'ack'; reqId: ReqId; status: number; data: unknown }
  | { type: 'error'; reqId: ReqId; status: number; data: { error: string } & Record<string, unknown> }
  | { type: 'book' | 'trade' | 'leaderboard' | 'chat'; data: unknown };
