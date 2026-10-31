// Polymarket's XTracker (https://xtracker.polymarket.com), the post counter Polymarket's Elon Musk markets (and
// Rizon's ELON-POSTS) resolve on. Each tracking is one counting window, with the link to its Polymarket event; its
// stats carry the count so far; the post list says when each post was recorded. Public and keyless.
import { getJson } from '../http.ts';

export const XTRACKER = 'https://xtracker.polymarket.com/api';

export interface Tracking {
  id: string;
  title: string;
  start: number;
  end: number;
  /** The Polymarket event's slug, from the tracking's marketLink. */
  slug: string | null;
}

export function parseTrackings(json: unknown): Tracking[] {
  const list = (json as { data?: { trackings?: Record<string, unknown>[] } }).data?.trackings;
  if (!Array.isArray(list)) throw new Error('no trackings');
  return list.flatMap((t) => {
    const start = Date.parse(String(t.startDate));
    const end = Date.parse(String(t.endDate));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    const link = typeof t.marketLink === 'string' ? t.marketLink : '';
    return [{ id: String(t.id), title: String(t.title ?? ''), start, end, slug: link.match(/\/event\/([^/?#]+)/)?.[1] ?? null }];
  });
}

export async function trackings(handle = 'elonmusk'): Promise<Tracking[]> {
  return parseTrackings(await getJson(`${XTRACKER}/users/${handle}`, 5 * 60_000));
}

/** The count so far in a tracking's window. */
export function parseTotal(json: unknown): number {
  const total = (json as { data?: { stats?: { total?: unknown } } }).data?.stats?.total;
  if (typeof total !== 'number' || !Number.isFinite(total)) throw new Error('no count');
  return total;
}

/** The count so far, and XTracker's pace: the total the window would end on at its rate so far. */
export function parseStats(json: unknown): { total: number; pace: number | null } {
  const pace = (json as { data?: { stats?: { pace?: unknown } } }).data?.stats?.pace;
  return { total: parseTotal(json), pace: typeof pace === 'number' && Number.isFinite(pace) ? pace : null };
}

export async function trackingStats(id: string): Promise<{ total: number; pace: number | null }> {
  return parseStats(await getJson(`${XTRACKER}/trackings/${id}?includeStats=true`, 30_000));
}

/** A post as XTracker recorded it: its id, and when the count rose for it (importedAt), in ms. */
export interface Post {
  id: string;
  at: number;
}

/** The posts in a GET /users/:handle/posts answer (rows without an id or a time skipped), oldest first. */
export function parsePosts(json: unknown): Post[] {
  const list = (json as { data?: { id?: unknown; importedAt?: unknown }[] }).data;
  if (!Array.isArray(list)) throw new Error('no posts');
  return list
    .flatMap((p) => {
      const at = typeof p.importedAt === 'string' ? Date.parse(p.importedAt) : NaN;
      return typeof p.id === 'string' && Number.isFinite(at) ? [{ id: p.id, at }] : [];
    })
    .sort((a, b) => a.at - b.at);
}

const DAY = 86_400_000;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The posts dated from `from` to now (whole UTC days; a 90-day answer is about 1.5 MB with the posts' text). */
export async function postsSince(handle: string, from: number, now: number): Promise<Post[]> {
  const url = `${XTRACKER}/users/${handle}/posts?platform=x&startDate=${dayOf(from)}&endDate=${dayOf(now + DAY)}&timezone=UTC`;
  return parsePosts(await getJson(url, 0, false));
}

/**
 * One account's post history, as the ELON books learn from it: `days` days read once (and again every 6 hours, to
 * drop anything XTracker removed), the last 3 days every 10 minutes in between, merged by post id. One log serves
 * every book (a read in flight is shared).
 */
export class PostLog {
  times: number[] = [];
  /** When the history was last brought up to date. */
  readAt = -Infinity;
  /** The first day it covers. */
  from = NaN;
  private fullAt = -Infinity;
  private posts = new Map<string, number>();
  private reading: Promise<void> | null = null;

  constructor(
    readonly handle: string,
    readonly days: number,
    private readonly fetch: (from: number, now: number) => Promise<Post[]> = (from, now) => postsSince(handle, from, now),
  ) {}

  /** Brings the history up to date when it's older than 10 minutes; throws (keeping what it had) when a read fails. */
  refresh(now: number): Promise<void> {
    if (now - this.readAt < 10 * 60_000) return Promise.resolve();
    this.reading ??= this.read(now).finally(() => (this.reading = null));
    return this.reading;
  }

  private async read(now: number): Promise<void> {
    const full = now - this.fullAt >= 6 * 3_600_000;
    const from = full ? now - this.days * DAY : now - 3 * DAY;
    const posts = await this.fetch(from, now);
    // a whole history with hardly anything in it, or starting days late, isn't one: keep the last
    if (full && (posts.length < 100 || posts[0].at > from + 3 * DAY)) throw new Error(`XTracker's post list looks short (${posts.length} posts from ${dayOf(posts[0]?.at ?? now)})`);
    if (full) {
      this.posts = new Map(posts.map((p) => [p.id, p.at]));
      this.fullAt = now;
      this.from = Date.parse(dayOf(from));
    } else for (const p of posts) this.posts.set(p.id, p.at);
    this.times = [...this.posts.values()].sort((a, b) => a - b);
    this.readAt = now;
  }
}
