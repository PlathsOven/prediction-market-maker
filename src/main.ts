// Runs the market makers: bun src/main.ts. Settings are environment variables (README.md): RIZON_URL, RIZON_KEY,
// MARKETS, SIZE, LEVELS, ...; the house deployment sets BOT_KEY and MAKER_FILE instead of a key.
// SIGTERM or Ctrl-C cancels every quote before it exits.
import { config } from './config.ts';
import { Rest, resolveKey } from './rizon.ts';
import { Runner } from './runner.ts';

const clock = (t = Date.now()) => new Date(t).toISOString().slice(11, 19);
const log = (line: string) => console.log(`${clock()} bots: ${line}`);

const cfg = config(process.env);
let runner: Runner | null = null;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void (runner ? runner.stop() : Promise.resolve()).finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// until the server answers (it may be starting next to us), retry
let backoff = 1_000;
let key: string | null = null;
while (!key && !stopping) {
  try {
    const r = await resolveKey({ url: cfg.url, key: cfg.key, file: cfg.file, botKey: cfg.botKey, log });
    key = r.key;
    log(`${cfg.url} as ${r.account.name} · balance $${r.account.balance.toFixed(0)}${cfg.house ? ' · house maker' : ''}`);
  } catch (err) {
    log(`${(err as Error).message}; retrying in ${backoff / 1000}s`);
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}
if (key && !stopping) {
  runner = new Runner({ rest: new Rest(cfg.url, key), sizing: cfg.sizing, feed: cfg.feed, allow: cfg.allow, maxNet: cfg.maxNet, log, verbose: cfg.verbose, quoteNotLive: cfg.quoteNotLive });
  await runner.start();
}
