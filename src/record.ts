// The public record: three plain rules, an account each, one $100 position on BTC-1m every minute, so anyone can check
// whether a rule makes money after the spread: bun src/record.ts. They trade through the public API under their own
// names, and rizon.markets/bots shows each one's record, the losers too.
// Settings: RIZON_URL, MAKER_FILE (each rule's key sits beside it: maker-record-COINFLIP-BOT.json).
import type { Market, Side } from './api.ts';
import { Rest, resolveKey } from './rizon.ts';

export type Rule = (now: number, before: number) => Side;

export const RULES: Readonly<Record<string, Rule>> = {
  // the baseline: no view at all, so what it loses is what the spread costs
  'COINFLIP-BOT': () => (Math.random() < 0.5 ? 'up' : 'down'),
  // the last minute's move carries on
  'MOMENTUM-BOT': (now, before) => (now >= before ? 'up' : 'down'),
  // the last minute's move reverses
  'REVERSAL-BOT': (now, before) => (now >= before ? 'down' : 'up'),
};

const MARKET = 'BTC-1m';
const SIZE = 100;
const MINUTE_MS = 60_000;

async function main(): Promise<void> {
  const url = (process.env.RIZON_URL ?? 'https://rizon.markets').replace(/\/$/, '');
  const file = process.env.MAKER_FILE ?? 'record.json';
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} record: ${line}`);
  const bots: { name: string; rule: Rule; rest: Rest }[] = [];
  for (const [name, rule] of Object.entries(RULES)) {
    for (let wait = 1_000; ; wait = Math.min(wait * 2, 30_000)) {
      try {
        const { key } = await resolveKey({ url, file: file.replace(/\.json$/, `-${name}.json`), botKey: process.env.BOT_KEY, name, log });
        bots.push({ name, rule, rest: new Rest(url, key) });
        break;
      } catch (err) {
        log(`${name}: ${(err as Error).message}; retrying in ${wait / 1000}s`);
        await Bun.sleep(wait);
      }
    }
  }
  let before: number | null = null;
  const tick = async () => {
    const m: Market | undefined = (await bots[0].rest.markets().catch(() => [])).find((x) => x.id === MARKET);
    if (!m || m.spot === null || !m.live || m.status !== 'open') return;
    const now = m.spot;
    if (before !== null) {
      for (const bot of bots) {
        const r = await bot.rest.call('POST', '/orders', { market: MARKET, side: bot.rule(now, before), size: SIZE }).catch(() => null);
        // an account made without a bot key starts with $1,000: back to it once it's nearly gone
        if (r?.status === 409) await bot.rest.call('POST', '/me/refill').catch(() => null);
      }
    }
    before = now;
  };
  log(`${bots.map((b) => b.name).join(', ')}: $${SIZE} on ${MARKET} every minute`);
  setInterval(() => void tick(), MINUTE_MS);
  void tick();
}

if (import.meta.main) void main();
