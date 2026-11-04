// A live read, with no orders: for every market the bots read from another venue or a status page, what each
// source says (its buckets or points, as bid / ask → the probability used), the implied median, and the ladder
// the bot would quote. Markets the exchange lists use its grid, bounds and dates; the rest use src/markets.ts.
//   bun src/read.ts                 every market
//   bun src/read.ts HOUSE FED-2027  the ones whose id or underlying starts with these
//   RIZON_URL=http://localhost:14636 bun src/read.ts
import type { Market } from './api.ts';
import { config } from './config.ts';
import { fmtStrike, fmtValue } from './format.ts';
import { marketsToRead } from './listing.ts';
import { createModel } from './markets.ts';
import { DistModel, strikesOf } from './models/model.ts';
import { Rest } from './rizon.ts';

const cfg = config(process.env);
const now = Date.now();
const filters = process.argv.slice(2).map((s) => s.toLowerCase());
const wanted = (m: Pick<Market, 'id' | 'underlying'>) => !filters.length || filters.some((f) => m.id.toLowerCase().startsWith(f) || m.underlying.toLowerCase().startsWith(f));

const listed = await new Rest(cfg.url).markets().catch(() => [] as Market[]);

const pct = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 2 : 1)}%`;
const cents = (x: number | null) => (x === null ? '–' : `${+(x * 100).toFixed(2)}`);
const summary: string[][] = [];

const toRead = await marketsToRead(listed);

for (const { market, fromExchange } of toRead) {
  if (!wanted(market)) continue;
  const model = createModel(market, { sizing: cfg.sizing, listing: () => market });
  if (!(model instanceof DistModel)) continue;
  await model.refresh(now);
  const b = model.current(now);
  const unit = market.unit;
  console.log(`\n${market.id} (${unit}) · ${fromExchange ? 'listed on the exchange' : 'not listed yet: grid from src/markets.ts'}`);
  const d = b ? model.distOf(b, market) : null;
  if (!b || d === null || typeof d === 'string') {
    const why = (typeof d === 'string' ? d : null) ?? model.problem ?? 'no read';
    console.log(`  not quoting: ${why}`);
    summary.push([market.id, '—', '—', '—', why]);
    continue;
  }
  for (const r of b.reports) {
    const head = `  ${r.name} · ${r.weight > 0 ? `weight ${pct(r.weight)}` : 'check'}${r.median !== null ? ` · median ${fmtValue(unit, r.median)}` : ''}${r.rows.length ? ` · spread ${(r.spread * 100).toFixed(1)}¢` : ''}`;
    console.log(head + (r.error ? ` · ${r.error}` : ''));
    if (r.note) console.log(`    ${r.note}`);
    if (r.rows.length) console.log(`    ${r.rows.map((x) => `${x.label} ${cents(x.bid)}/${cents(x.ask)}→${pct(x.p)}`).join(' · ')}`);
  }
  const t = model.target(market, now);
  const bids = t.quotes.filter((q) => q.side === 'up').map((q) => q.strike);
  const asks = t.quotes.filter((q) => q.side === 'down').map((q) => q.strike);
  const g = strikesOf(market, now);
  console.log(`  implied median ${fmtValue(unit, d.median())} · 46th–54th percentile ${fmtValue(unit, d.quantile(0.46))} – ${fmtValue(unit, d.quantile(0.54))}${b.thin ? ' · thin source: quoted wider' : ''}`);
  console.log(`  strikes ${g.offset} + n × ${g.step}${g.min !== null ? `, from ${g.min}` : ''}${g.max !== null ? ` to ${g.max}` : ''}`);
  console.log(`  would quote: bids ${bids.map((k) => fmtStrike(unit, k)).join(', ') || '—'}`);
  console.log(`               asks ${asks.map((k) => fmtStrike(unit, k)).join(', ') || '—'}${t.reason ? `  (${t.reason})` : ''}`);
  if (t.note) console.log(`  ${t.note}`);
  summary.push([
    market.id,
    fmtValue(unit, d.median()),
    bids.length ? fmtStrike(unit, bids[0]) : '—',
    asks.length ? fmtStrike(unit, asks[0]) : '—',
    b.reports.filter((r) => r.weight > 0).map((r) => `${r.name.replace(/^Polymarket /, 'PM ').replace(/^Kalshi /, 'K ')} ${pct(r.weight)}`).join(' + ') + (b.thin ? ' (thin)' : '') + (t.note ? ' (wider)' : ''),
  ]);
}

console.log('\n| Market | Implied median | Best bid | Best ask | Sources |\n|---|---|---|---|---|');
for (const row of summary) console.log(`| ${row.join(' | ')} |`);
