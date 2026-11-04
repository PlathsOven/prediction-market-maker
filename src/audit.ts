// The fair-value audit, with no orders: for every market, the bots' fair value now (the spot a feed market's ladder
// centres on, or a distribution's median) beside an independent reference for the same number and the exchange's
// own book, read live.
//   bun src/audit.ts                       every market
//   bun src/audit.ts --latency 30          also watch the feed books for 30 s: how long a move takes to reach them
//   RIZON_URL=http://localhost:14636 bun src/audit.ts
//
// The references are meant to be independent of what the bot quotes from: the other venue alone, a separate event
// on the same question, the venue's own last trades, a perpetual future, a status page's published uptime, or a
// model from the source's own history.
import type { Market } from './api.ts';
import { type PolymarketBuckets, viewKalshi, viewPmBuckets, viewPmLadder } from './analogs.ts';
import { config } from './config.ts';
import { Dist, normInv } from './dist.ts';
import { fmtValue } from './format.ts';
import { jdnOf } from './grid.ts';
import { getJson } from './http.ts';
import { marketsToRead } from './listing.ts';
import { CATALOG, createModel, guardsOf } from './markets.ts';
import { viewPmDates, viewPmDays } from './models/date.ts';
import { polymarketCheck, polymarketWeight } from './models/elon.ts';
import { DistModel, type Model } from './models/model.ts';
import { windowUptimes } from './models/uptime.ts';
import { businessDaysLeft } from './models/ust10y.ts';
import { Rest } from './rizon.ts';
import { ksEvent } from './sources/kalshi.ts';
import { USD_BILLIONS, atLastTrades, pmEvent } from './sources/polymarket.ts';
import { atlassianHistory, instatusHome, outageDays } from './sources/statuspage.ts';
import { fredCloses, mergeCloses, treasuryCloses } from './sources/treasury.ts';

const cfg = config(process.env);
const now = Date.now();
const args = process.argv.slice(2);
const latencyS = args.includes('--latency') ? Number(args[args.indexOf('--latency') + 1] ?? 30) : 0;

interface Reference {
  name: string;
  value: number;
}

const mid = (bid: unknown, ask: unknown) => (Number(bid) + Number(ask)) / 2;
const coinbase = async (product: string) => {
  const t = await getJson<{ bid: string; ask: string }>(`https://api.exchange.coinbase.com/products/${product}/ticker`, 0);
  return mid(t.bid, t.ask);
};
const kraken = async (pair: string) => {
  const t = await getJson<{ result: Record<string, { a: string[]; b: string[] }> }>(`https://api.kraken.com/0/public/Ticker?pair=${pair}`, 0);
  const r = Object.values(t.result)[0];
  return mid(r.b[0], r.a[0]);
};
const kalshiAlone = async (u: string): Promise<Reference> => {
  const s = CATALOG[u].spec;
  if (s.model !== 'event') throw new Error(u);
  const o = { value: s.value, support: s.support };
  const parts: [Dist, number][] = [];
  for (const src of s.sources) if (src.venue === 'kalshi') parts.push([viewKalshi(await ksEvent(src.event), src, o).dist, src.weight ?? 1]);
  return { name: `Kalshi alone (${s.sources.filter((x) => x.venue === 'kalshi').map((x) => (x.venue === 'kalshi' ? x.event : '')).join(' + ')})`, value: Dist.mix(parts).median() };
};
const dateOptions = (m: Market, zone: string) => ({ zone, now, deadline: jdnOf(m.deadline ?? Date.parse('2026-12-31T12:00:00Z')) });

/** The last n whole days' uptime as the page published it (yesterday back), in percent. */
const publishedUptime = (days: { day: string; down: number }[], n: number) => windowUptimes(days, n, new Date(now).toISOString().slice(0, 10)).at(-1)?.u ?? NaN;

const REFERENCES: Record<string, (m: Market) => Promise<Reference>> = {
  'BTC-USD': async () => ({ name: 'Coinbase BTC-USD mid', value: await coinbase('BTC-USD') }),
  'PAXG-USD': async () => {
    const [c, k] = await Promise.all([coinbase('PAXG-USD'), kraken('PAXGUSD')]);
    return { name: 'Coinbase and Kraken PAXG mids, averaged', value: (c + k) / 2 };
  },
  'HOUSE-R-2026': () => kalshiAlone('HOUSE-R-2026'),
  'SENATE-R-2026': () => kalshiAlone('SENATE-R-2026'),
  'HOUSE-VOTE-2026': () => kalshiAlone('HOUSE-VOTE-2026'),
  'IRAN-STRIKE': async (m) => {
    const ev = await pmEvent('us-iran-ceasefire-continues-throughptptpt');
    const v = viewPmDates(atLastTrades(ev), { venue: 'polymarket', slug: ev.slug, shape: 'survival', zone: 'Asia/Tehran' }, dateOptions(m, 'UTC'));
    return { name: 'its Polymarket ladder at its last trades', value: v.dist.median() };
  },
  'ANTH-IPO-DATE': async (m) => {
    const v = viewPmDays(await pmEvent('anthropic-ipo-date'), { venue: 'polymarket', slug: 'anthropic-ipo-date', shape: 'days', zone: 'America/New_York' }, dateOptions(m, 'America/New_York'));
    return { name: 'Polymarket anthropic-ipo-date (day buckets)', value: v.dist.median() };
  },
  'ANTH-IPO-CAP': async () => {
    const ev = await pmEvent('anthropic-ipo-closing-market-cap-above');
    const v = viewPmLadder(ev, { venue: 'polymarket', slug: ev.slug, shape: 'survival', labels: { scale: USD_BILLIONS } }, { value: { type: 'continuous' }, support: [1000, 3500] });
    return { name: 'Polymarket anthropic-ipo-closing-market-cap-above (a ladder)', value: v.dist.median() };
  },
  'FABLE-NEXT': async (m) => {
    const slug = 'next-fable-model-5pt2-released-onptptpt-20261027';
    const v = viewPmDays(await pmEvent(slug), { venue: 'polymarket', slug, shape: 'days', zone: 'America/New_York' }, dateOptions(m, 'America/New_York'));
    return { name: `Polymarket ${slug} (day buckets, thin)`, value: v.dist.median() };
  },
  'FED-2027': async () => {
    const s = CATALOG['FED-2027'].spec;
    if (s.model !== 'event') throw new Error('FED');
    const src = s.sources[0] as PolymarketBuckets;
    const v = viewPmBuckets(atLastTrades(await pmEvent(src.slug)), src, { value: s.value, support: s.support });
    return { name: 'its Polymarket buckets at their last trades', value: v.dist.median() };
  },
  'UST10Y-MAX-2026': async () => {
    // the running maximum of a driftless walk with the yield's own daily volatility (last 60 closes): no venue at all
    const [t, f] = await Promise.all([treasuryCloses(2026).catch(() => []), fredCloses('DGS10', '2026-06-01').catch(() => [])]);
    const closes = mergeCloses(t, f);
    const recent = closes.slice(-61).map((c) => c.value);
    const moves = recent.slice(1).map((v, i) => v - recent[i]);
    const sd = Math.sqrt(moves.reduce((a, d) => a + d * d, 0) / moves.length);
    const left = businessDaysLeft(now, '2026-12-31');
    const x0 = closes.at(-1)!.value;
    const floor = Math.max(x0, ...closes.filter((c) => c.day >= '2026-10-29').map((c) => c.value));
    const s = sd * Math.sqrt(left);
    // P(max ≥ x) = 2 (1 − Φ((x − x0) / s)) = 0.5 at x0 + s Φ⁻¹(0.75)
    return { name: `reflection from the 10Y's own daily moves (${(sd * 100).toFixed(1)} bp a day, ${left} days left)`, value: Math.max(floor, x0 + s * normInv(0.75)) };
  },
  'ELON-POSTS': async (m) => {
    // Polymarket's crowd: its window nearest the horizon, as posts to come, on top of the count now. Not wholly
    // independent: the forecast moves up to halfway toward it (the last day's pace, the other plain reference,
    // forecasts the next day worse than the history's rate does: a spree fades within a day)
    const c = await polymarketCheck(now, (m.horizon ?? 86_400) * 1000);
    return { name: `${c.name}, as posts to come (the fair value leans ${Math.round(polymarketWeight(c) * 100)}% on it)`, value: (m.spot ?? NaN) + c.median };
  },
  'PREDICT-FDV': async () => {
    // a perpetual's price is about the mean of a skewed FDV, the bot quotes its median: for a lognormal, median =
    // mean × e^(−σ²/2), σ the log-spread (taken from the FDV ladder's own 16th to 84th percentiles)
    const p = await getJson<{ markPrice: string }>('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=PREDICTUSDT', 0);
    const mark = Number(p.markPrice);
    const ev = await pmEvent('predictfun-fdv-above-one-day-after-launch');
    const d = viewPmLadder(ev, { venue: 'polymarket', slug: ev.slug, shape: 'survival', labels: { scale: USD_BILLIONS } }, { value: { type: 'continuous' }, support: [0, 6], conditional: true }).dist;
    const sigma = Math.log(d.quantile(0.84) / d.quantile(0.16)) / 2;
    return { name: `Binance PREDICTUSDT perp mark $${mark.toFixed(3)}B, as a median (log-spread ${sigma.toFixed(2)})`, value: mark * Math.exp((-sigma * sigma) / 2) };
  },
};

async function uptimeReference(m: Market): Promise<Reference> {
  const n = Math.round((m.horizon ?? 0) / 86_400);
  if (m.underlying.startsWith('CLAUDE')) {
    const days = await atlassianHistory('https://status.claude.com', 'rwppv331jlwc', 2);
    if (n === 30) {
      const show = await getJson<{ values: { thirty: number }[] }>('https://status.claude.com/uptime_showcase?components=rwppv331jlwc', 10 * 60_000);
      return { name: 'status.claude.com: its published 30-day uptime', value: show.values[0].thirty };
    }
    return { name: `status.claude.com: its last ${n} whole day${n > 1 ? 's' : ''}, as published`, value: publishedUptime(days, n) };
  }
  const home = await instatusHome('https://status.polymarket.com', 'cljg99p53207029broc36bdpn0h');
  return { name: `status.polymarket.com: its last ${n} whole day${n > 1 ? 's' : ''}, from its outages`, value: publishedUptime(outageDays(home.outages, home.from, Math.min(home.to, now)), n) };
}

const listed = await new Rest(cfg.url).markets().catch(() => [] as Market[]);
const rows: string[][] = [];
const deps = (m: Market) => ({ sizing: cfg.sizing, listing: () => m });
for (const { market, fromExchange } of await marketsToRead(listed, true)) {
  const entry = CATALOG[market.underlying];
  const model: Model | null = createModel(market, deps(market));
  let fair: number | null = null;
  let note = '';
  if (model instanceof DistModel) {
    await model.refresh(now);
    const b = model.current(now);
    const d = b ? model.distOf(b, market) : null;
    fair = d && typeof d !== 'string' ? d.median() : null;
    note = model.held ?? model.problem ?? model.target(market, now).note ?? '';
  } else fair = market.spot;
  const bookMid = fromExchange && market.bid !== null && market.ask !== null ? (market.bid + market.ask) / 2 : null;
  const refOf = REFERENCES[market.underlying] ?? (entry.spec.model === 'uptime' ? uptimeReference : null);
  let ref: Reference | null = null;
  try {
    ref = refOf ? await refOf(market) : null;
  } catch (err) {
    note = `${note ? `${note}; ` : ''}reference: ${(err as Error).message}`;
  }
  const scale = guardsOf(entry, market)?.scale;
  const gap = fair !== null && ref && Number.isFinite(ref.value) ? fair - ref.value : null;
  const cadence = model instanceof DistModel ? `every ${Math.round(model.pollMs / 1000)} s` : 'every price';
  rows.push([
    market.id,
    fair === null ? '—' : fmtValue(market.unit, fair),
    bookMid === null ? '—' : fmtValue(market.unit, bookMid),
    ref ? fmtValue(market.unit, ref.value) : '—',
    gap === null ? '—' : `${gap >= 0 ? '+' : ''}${+gap.toFixed(3)}${scale ? ` (${+(gap / scale).toFixed(2)} scales)` : ''}`,
    cadence,
    ref?.name ?? '',
    note,
  ]);
}

console.log('| Market | Fair value | Book mid | Reference | Fair − reference | Re-read | Reference is | Note |\n|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.join(' | ')} |`);

if (latencyS > 0 && listed.length) await watchFeeds(listed, latencyS);

/**
 * How long a feed book stays behind its price: the episodes in which its best ask stands at or under spot, or its
 * best bid at or over it (a taker would win half the time or more), from the price that put it there to the book
 * update (public channel, at most 10 a second) that ends it. Sticky books lag on purpose on the safe side; this
 * only counts the side that matters.
 */
async function watchFeeds(markets: readonly Market[], seconds: number): Promise<void> {
  const feeds = markets.filter((m) => (m.kind ?? 'rolling') === 'rolling' && ['BTC-USD', 'PAXG-USD'].includes(m.underlying));
  const channels = [...new Set(feeds.map((m) => `price:${m.underlying}`)), ...feeds.map((m) => `book:${m.id}`)];
  const ws = new WebSocket(`${cfg.url.replace(/^http/, 'ws')}/api/v1/ws?channels=${channels.join(',')}`);
  const spots = new Map<string, number>();
  const tops = new Map<string, { bid: number | null; ask: number | null }>();
  const since = new Map<string, number>();
  const episodes = new Map<string, number[]>();
  const moves = new Map<string, number>();
  const through = (id: string, spot: number | undefined) => {
    const t = tops.get(id);
    return spot !== undefined && !!t && ((t.ask !== null && t.ask <= spot) || (t.bid !== null && t.bid >= spot));
  };
  const check = (m: Market, t: number) => {
    const bad = through(m.id, spots.get(m.underlying));
    if (bad && !since.has(m.id)) since.set(m.id, t);
    if (!bad && since.has(m.id)) {
      const list = episodes.get(m.id) ?? [];
      list.push(t - since.get(m.id)!);
      episodes.set(m.id, list);
      since.delete(m.id);
    }
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { type: string; data: Record<string, unknown> };
    const t = Date.now();
    if (msg.type === 'price') {
      const u = String(msg.data.underlying);
      spots.set(u, Number(msg.data.price));
      for (const m of feeds.filter((x) => x.underlying === u)) {
        moves.set(m.id, (moves.get(m.id) ?? 0) + 1);
        check(m, t);
      }
    } else if (msg.type === 'book') {
      const m = feeds.find((x) => x.id === msg.data.market);
      if (!m) return;
      const bids = msg.data.bids as { strike: number }[];
      const asks = msg.data.asks as { strike: number }[];
      tops.set(m.id, { bid: bids[0]?.strike ?? null, ask: asks[0]?.strike ?? null });
      check(m, t);
    }
  };
  await Bun.sleep(seconds * 1000);
  ws.close();
  console.log(`\nFeed books behind their price (${seconds} s watched): episodes at or through spot, p50 / p90 / longest, and how many`);
  for (const m of feeds) {
    const s = [...(episodes.get(m.id) ?? [])].sort((a, b) => a - b);
    const total = s.reduce((a, b) => a + b, 0);
    console.log(
      s.length
        ? `${m.id}: ${s[Math.floor(s.length / 2)]} / ${s[Math.floor(s.length * 0.9)]} / ${s.at(-1)} ms, ${s.length} episodes over ${moves.get(m.id) ?? 0} prices, ${((100 * total) / (seconds * 1000)).toFixed(1)}% of the time`
        : `${m.id}: never at or through spot over ${moves.get(m.id) ?? 0} prices`,
    );
  }
}
