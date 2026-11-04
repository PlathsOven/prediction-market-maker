// Status pages, for the uptime markets. Both pages count downtime the way Atlassian Statuspage documents it:
// major-outage time plus 0.3 × partial-outage time (degraded performance and maintenance don't count).
//
//   Atlassian Statuspage (status.claude.com): /uptime/<id>?page=N has three months a page of each day's partial (p)
//     and major (m) outage seconds, back to the component's start (/uptime_showcase?components=<id> has the last 90
//     days of the same); /api/v2/components.json has each component's status now.
//   Instatus (status.polymarket.com): the home page embeds each component's outages over the last 90 days as
//     exact intervals (inside the Next.js payload: undocumented, so read defensively); /v2/components.json has
//     each component's status now.
import { getJson, getText } from '../http.ts';

/** Partial outage counts this much of its time as down. */
export const PARTIAL_WEIGHT = 0.3;

export interface OutageDay {
  /** YYYY-MM-DD (UTC) */
  day: string;
  /** Weighted down seconds: major + 0.3 × partial. */
  down: number;
}

/** Whether a component is in an outage right now (degraded performance and maintenance aren't). */
export type Status = 'up' | 'partial' | 'major';

// ---- Atlassian Statuspage -----------------------------------------------------------------------------------

export function parseShowcase(json: unknown, component: string): OutageDay[] {
  const days = (json as { timelines?: Record<string, { days?: { date: string; outages?: { p?: number; m?: number } }[] }> }).timelines?.[component]?.days;
  if (!Array.isArray(days) || !days.length) throw new Error(`no uptime days for ${component}`);
  return days.map((d) => ({ day: d.date, down: (d.outages?.m ?? 0) + PARTIAL_WEIGHT * (d.outages?.p ?? 0) }));
}

export function parseAtlassianStatus(json: unknown, component: string): Status {
  const c = (json as { components?: { id: string; status: string }[] }).components?.find((x) => x.id === component);
  if (!c) throw new Error(`no component ${component}`);
  return c.status === 'major_outage' ? 'major' : c.status === 'partial_outage' ? 'partial' : 'up';
}

const ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
const unescapeHtml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? all),
  );

/**
 * One page of a component's uptime history (/uptime/<id>?page=N: three months a page, page 1 the latest, back to
 * the component's start): each day's weighted outage seconds. Days still to come in the current month have no
 * date and are skipped.
 */
export function parseUptimePage(html: string): OutageDay[] {
  const raw = html.match(/data-react-props="([^"]*)"/)?.[1];
  if (!raw) throw new Error('no uptime history on the page');
  const props = JSON.parse(unescapeHtml(raw)) as { months?: { days?: { date?: string; p?: number; m?: number }[] }[] };
  if (!Array.isArray(props.months)) throw new Error('no months in the uptime history');
  const days: OutageDay[] = [];
  for (const mo of props.months) for (const d of mo.days ?? []) if (d.date) days.push({ day: d.date.slice(0, 10), down: (d.m ?? 0) + PARTIAL_WEIGHT * (d.p ?? 0) });
  return days;
}

/** A component's daily history over the last `pages` pages (three months each), oldest first. */
export async function atlassianHistory(base: string, component: string, pages: number): Promise<OutageDay[]> {
  const read = await Promise.all(Array.from({ length: pages }, (_, i) => getText(`${base}/uptime/${component}?page=${i + 1}`, 30 * 60_000)));
  const days = new Map<string, OutageDay>();
  for (const html of read) for (const d of parseUptimePage(html)) days.set(d.day, d);
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** A page's components now: read at most once a minute, whichever of its markets asks (1, 7 and 30 days share it). */
export async function atlassianStatus(base: string, component: string): Promise<Status> {
  return parseAtlassianStatus(await getJson(`${base}/api/v2/components.json`, 55_000), component);
}

// ---- Instatus -------------------------------------------------------------------------------------------------

export interface Outage {
  from: number;
  /** null while it's still going on */
  to: number | null;
  status: string;
}

/** The JSON object that follows "key": in text, by matching braces (strings respected). */
function objectAfter(text: string, key: string): unknown {
  const at = text.indexOf(`"${key}":`);
  if (at < 0) return null;
  const start = text.indexOf('{', at);
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return null;
}

/** The home page's outages for one component, and the window the page covers. */
export function parseInstatusHome(html: string, component: string): { from: number; to: number; outages: Outage[] } {
  // the page's data is in Next.js flight chunks: self.__next_f.push([1,"<a JSON string>"])
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) flight += JSON.parse(`"${m[1]}"`);
  const all = objectAfter(flight, 'componentsUptime') as Record<string, { outages?: { from: string; to: string | null; status: string }[] }> | null;
  const c = all?.[component];
  if (!c || !Array.isArray(c.outages)) throw new Error(`no outages for ${component}`);
  // the window the uptimes cover is given just before them: the last start and end dates ahead of the key
  const before = flight.slice(0, flight.indexOf('"componentsUptime":'));
  const from = Date.parse([...before.matchAll(/"startDate":"([^"]+)"/g)].at(-1)?.[1] ?? '');
  const to = Date.parse([...before.matchAll(/"endDate":"([^"]+)"/g)].at(-1)?.[1] ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('no window on the page');
  return {
    from,
    to,
    outages: c.outages.map((o) => ({ from: Date.parse(o.from), to: o.to === null ? null : Date.parse(o.to), status: o.status })),
  };
}

export function parseInstatusStatus(json: unknown, component: string): Status {
  const c = (json as { components?: { id: string; status: string }[] }).components?.find((x) => x.id === component);
  if (!c) throw new Error(`no component ${component}`);
  return c.status === 'MAJOROUTAGE' ? 'major' : c.status === 'PARTIALOUTAGE' ? 'partial' : 'up';
}

export async function instatusHome(base: string, component: string): Promise<{ from: number; to: number; outages: Outage[] }> {
  return parseInstatusHome(await getText(`${base}/`, 10 * 60_000), component);
}

export async function instatusStatus(base: string, component: string): Promise<Status> {
  return parseInstatusStatus(await getJson(`${base}/v2/components.json`, 55_000), component);
}

const DAY = 86_400_000;
const weightOf = (status: string): number => (status === 'MAJOROUTAGE' ? 1 : status === 'PARTIALOUTAGE' ? PARTIAL_WEIGHT : 0);

/**
 * Outage intervals as weighted down seconds per UTC day, from the day `from` falls in to the one `to` does.
 * Overlapping intervals count once, at the heavier weight.
 */
export function outageDays(outages: readonly Outage[], from: number, to: number): OutageDay[] {
  const spans = outages
    .map((o) => ({ a: o.from, b: Math.min(o.to ?? to, to), w: weightOf(o.status) }))
    .filter((s) => s.w > 0 && s.b > s.a);
  const cuts = [...new Set(spans.flatMap((s) => [s.a, s.b]))].sort((x, y) => x - y);
  const firstDay = Math.floor(from / DAY);
  const days = Array.from({ length: Math.floor(to / DAY) - firstDay + 1 }, (_, i) => ({
    day: new Date((firstDay + i) * DAY).toISOString().slice(0, 10),
    down: 0,
  }));
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const w = Math.max(0, ...spans.filter((s) => s.a <= a && s.b >= b).map((s) => s.w));
    // split the piece at UTC midnights
    for (let t = a; t < b; ) {
      const end = Math.min(b, (Math.floor(t / DAY) + 1) * DAY);
      const d = days[Math.floor(t / DAY) - firstDay];
      if (d) d.down += (w * (end - t)) / 1000;
      t = end;
    }
  }
  return days;
}
