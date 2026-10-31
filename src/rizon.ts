// Rizon's REST API (/api/v1), and the bot's account key.
//
// A key comes from, in order: RIZON_KEY (your own: make one at https://rizon.markets/docs#keys); the key file
// (MAKER_FILE, by server URL), while the server still accepts it; or a new account, which the bot makes once and
// saves to the key file. A new account is an ordinary one from POST /api/v1/accounts ($1,000 paper), except on
// the house deployment, which sets BOT_KEY: there the market maker's account is made through the app's bot route
// and funded with enough paper to quote every book.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Account, Market } from './api.ts';

export class Rest {
  readonly api: string;

  constructor(
    readonly url: string,
    public key: string | null = null,
  ) {
    this.api = `${url.replace(/\/$/, '')}/api/v1`;
  }

  async call<T>(method: string, path: string, body?: unknown, key: string | null = this.key): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { ...(key && { authorization: `Bearer ${key}` }), ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed as T };
  }

  async markets(): Promise<Market[]> {
    const r = await this.call<{ markets: Market[] }>('GET', '/markets');
    if (r.status !== 200) throw new Error(`GET /markets: ${r.status}`);
    return r.body.markets;
  }

  /** The exchange's order limit (GET /api/v1 rules), or 20. */
  async ordersPerSecond(): Promise<number> {
    const r = await this.call<{ rules?: { ordersPerSecond?: number } }>('GET', '');
    return r.status === 200 ? (r.body.rules?.ordersPerSecond ?? 20) : 20;
  }

  async cancelAll(): Promise<number> {
    const r = await this.call<{ canceled?: unknown[] }>('DELETE', '/orders?all=true');
    return r.body?.canceled?.length ?? 0;
  }
}

interface Saved {
  key: string;
  id: string;
  name: string;
}

async function readSaved(file: string): Promise<Record<string, Saved>> {
  try {
    return JSON.parse(await Bun.file(file).text()) as Record<string, Saved>;
  } catch {
    return {};
  }
}

async function save(file: string, url: string, saved: Saved): Promise<void> {
  const all = await readSaved(file);
  all[url] = saved;
  mkdirSync(dirname(file), { recursive: true });
  await Bun.write(file, `${JSON.stringify(all, null, 2)}\n`);
}

export interface KeyOptions {
  url: string;
  /** A trade key to use as is. */
  key?: string;
  /** Where made keys are kept, by server URL. */
  file: string;
  /** The house deployment's bot key: makes and funds the maker account. */
  botKey?: string;
  log: (line: string) => void;
}

/** The bot's trade key and account: see the top of this file. Throws while the server isn't up yet. */
export async function resolveKey(o: KeyOptions): Promise<{ key: string; account: Account }> {
  const rest = new Rest(o.url);
  if (o.key) {
    const me = await rest.call<Account>('GET', '/me', undefined, o.key);
    if (me.status !== 200) throw new Error(`RIZON_KEY refused: GET /me ${me.status}`);
    return { key: o.key, account: me.body };
  }
  const saved = (await readSaved(o.file))[o.url];
  if (saved) {
    const me = await rest.call<Account>('GET', '/me', undefined, saved.key);
    if (me.status === 200) return { key: saved.key, account: me.body };
    if (me.status !== 401) throw new Error(`GET /me: ${me.status}`);
    o.log(`the saved key was refused (a fresh database?): making a new account`);
  }
  if (o.botKey) {
    const res = await fetch(`${o.url.replace(/\/$/, '')}/api/guest`, { method: 'POST', headers: { 'x-bot-key': o.botKey, 'x-bot-kind': 'maker' } });
    if (res.status === 401) throw new Error('the server rejected BOT_KEY');
    if (!res.ok) throw new Error(`POST /api/guest: ${res.status}`);
    const { token, me } = (await res.json()) as { token: string; me: { id: string; name: string } };
    // the session that made the account makes its API key; from then on the bot only uses the key
    const made = await rest.call<{ key: string }>('POST', '/keys', { name: 'maker', scope: 'trade' }, token);
    if (made.status !== 201) throw new Error(`POST /keys: ${made.status}`);
    await save(o.file, o.url, { key: made.body.key, id: me.id, name: me.name });
    o.log(`made the maker account ${me.name}`);
    const acct = await rest.call<Account>('GET', '/me', undefined, made.body.key);
    return { key: made.body.key, account: acct.body };
  }
  const made = await rest.call<{ key: string; account: Account }>('POST', '/accounts', { keyName: 'rizon-bots' });
  if (made.status !== 201) throw new Error(`POST /accounts: ${made.status} ${JSON.stringify(made.body)}`);
  await save(o.file, o.url, { key: made.body.key, id: made.body.account.id, name: made.body.account.name });
  o.log(`made account ${made.body.account.name} (key saved to ${o.file})`);
  return made.body;
}
