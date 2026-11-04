// Settings, from the environment (see README.md).
import type { Market } from './api.ts';
import { LADDER } from './ladder.ts';
import type { Sizing } from './models/model.ts';

export interface Config {
  url: string;
  key?: string;
  botKey?: string;
  file: string;
  /** The house deployment (BOT_KEY): its maker account is funded to quote every book at full size. */
  house: boolean;
  allow: (m: Market) => boolean;
  sizing: Sizing;
  feed?: { size?: number; levels?: number };
  maxNet: number;
  verbose: boolean;
  /** Quote a rolling market whose number isn't live, rather than hold it: for an exchange that trades on stand-in values (Rizon's FEED=sim in dev). */
  quoteNotLive: boolean;
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s.trim() === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`not a number: ${s}`);
  return n;
};

/**
 * MARKETS: which markets to quote, comma-separated: market ids (BTC-15s), underlying ids (BTC-USD), or prefixes
 * ending in * (ELON-*), in any case; an entry starting with ! leaves those out (!PAXG-USD: everything but gold).
 * Empty: every market the bots have a model for.
 */
export function allowList(raw: string | undefined): (m: Market) => boolean {
  const items = (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const pick = items.filter((x) => !x.startsWith('!'));
  const skip = items.filter((x) => x.startsWith('!')).map((x) => x.slice(1));
  const hits = (list: string[], id: string) => list.some((x) => (x.endsWith('*') ? id.toLowerCase().startsWith(x.slice(0, -1)) : id.toLowerCase() === x));
  const matches = (list: string[], m: Market) => hits(list, m.id) || hits(list, m.underlying);
  return (m) => (!pick.length || matches(pick, m)) && !matches(skip, m);
}

export function config(env: Record<string, string | undefined>): Config {
  const key = env.RIZON_KEY?.trim() || undefined;
  const botKey = key ? undefined : env.BOT_KEY?.trim() || undefined;
  const house = botKey !== undefined;
  const size = num(env.SIZE);
  const levels = num(env.LEVELS);
  // a user's account starts with $1,000 paper: $2 a level on every book stays well inside it
  const eventSize = size ?? (house ? 500 : 2);
  // what a feed book's calibration gives way to, only what's set: a key left unset would blank the calibrated one
  const feedSize = size ?? (house ? undefined : 2);
  const feed =
    feedSize === undefined && levels === undefined ? undefined : { ...(feedSize !== undefined && { size: feedSize }), ...(levels !== undefined && { levels }) };
  return {
    url: (env.RIZON_URL ?? env.SERVER_URL ?? 'https://rizon.markets').trim().replace(/\/$/, ''),
    key,
    botKey,
    file: env.MAKER_FILE?.trim() || 'maker.json',
    house,
    allow: allowList(env.MARKETS),
    sizing: {
      ladder: { ...LADDER, sizes: [eventSize], levels: levels ?? LADDER.levels, margin: num(env.MARGIN) ?? LADDER.margin },
      thinMargin: num(env.THIN_MARGIN) ?? 0.07,
    },
    feed,
    maxNet: num(env.MAX_NET) ?? 20 * eventSize,
    verbose: env.LOG === 'verbose',
    quoteNotLive: env.QUOTE_NOT_LIVE === '1',
  };
}
