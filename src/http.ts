// Fetching other venues' public data, politely: at most one new request every 250 ms to a host (their answers may
// overlap), with a timeout, a short cache, one request for every caller that wants the same page at the same time
// (three uptime books reading one status page), and a User-Agent that says who's asking. Every source here is
// public and keyless.

const USER_AGENT = 'rizon-bots/0.1 (+https://rizon.markets/docs)';
/** Gap between the starts of two requests to one host. */
const HOST_GAP_MS = 250;
const TIMEOUT_MS = 20_000;

const cache = new Map<string, { at: number; body: string }>();
/** Each host's last booked start: the next one waits for it, and HOST_GAP_MS more. */
const turns = new Map<string, Promise<void>>();
const lastAt = new Map<string, number>();
/** Pages being fetched now: anyone else asking for one meanwhile gets the same answer. */
const inFlight = new Map<string, Promise<string>>();
/** A host that answered 429: not asked again before this (its Retry-After, else a minute); its cached answers serve meanwhile. */
const blockedUntil = new Map<string, number>();

/** Waits for the host's next free start. */
function turn(host: string): Promise<void> {
  const next = (turns.get(host) ?? Promise.resolve()).then(async () => {
    const wait = (lastAt.get(host) ?? 0) + HOST_GAP_MS - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    lastAt.set(host, Date.now());
  });
  turns.set(host, next);
  return next;
}

/**
 * The text at url, from the cache when it's younger than maxAgeMs. Throws on a non-2xx status, except while the
 * host is rate-limiting us: then the last answer we have (however old) serves, if there is one. keep: false for a
 * big answer the caller keeps itself (it isn't cached).
 */
export async function getText(url: string, maxAgeMs = 20_000, headers: Record<string, string> = {}, keep = true): Promise<string> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.body;
  const pending = inFlight.get(url);
  if (pending) return pending;
  const host = new URL(url).host;
  const held = () => {
    if ((blockedUntil.get(host) ?? 0) <= Date.now()) return null;
    if (hit) return hit.body;
    throw new Error(`${host} asked us to slow down (429)`);
  };
  const before = held();
  if (before !== null) return before;
  const run = async (): Promise<string> => {
    await turn(host);
    // a 429 may have come in while this one waited its turn
    const waited = held();
    if (waited !== null) return waited;
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      blockedUntil.set(host, Date.now() + (Number.isFinite(after) && after > 0 ? after * 1000 : 60_000));
      if (hit) return hit.body;
    }
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    if (keep) cache.set(url, { at: Date.now(), body });
    return body;
  };
  const p = run().finally(() => inFlight.delete(url));
  inFlight.set(url, p);
  return p;
}

export async function getJson<T>(url: string, maxAgeMs?: number, keep = true): Promise<T> {
  return JSON.parse(await getText(url, maxAgeMs, { accept: 'application/json' }, keep)) as T;
}
