// The polite fetch: a host that answers 429 isn't asked again until its Retry-After, and the last good answer
// serves meanwhile; requests to a host start 250 ms apart without waiting for each other's answers; callers asking
// for the same page at once share one request.
import { afterAll, expect, test } from 'bun:test';
import { getText } from '../src/http.ts';

let hits = 0;
let limited = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    hits++;
    if (new URL(req.url).pathname === '/slow') await Bun.sleep(800);
    return limited ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) : new Response(`answer ${hits}`);
  },
});
afterAll(() => server.stop(true));

test('a 429 serves the last answer and holds the host off for its Retry-After', async () => {
  const url = `http://localhost:${server.port}/status`;
  expect(await getText(url, 0)).toBe('answer 1');
  limited = true;
  // stale is allowed (max age 0), the host says 429: the last answer serves
  expect(await getText(url, 0)).toBe('answer 1');
  expect(hits).toBe(2);
  // held off: no request at all within its Retry-After
  expect(await getText(url, 0)).toBe('answer 1');
  expect(hits).toBe(2);
  // nothing cached for another path on that host: it says so instead of asking
  expect(getText(`http://localhost:${server.port}/other`, 0)).rejects.toThrow('429');
  expect(hits).toBe(2);
  limited = false;
  await Bun.sleep(2_100);
  expect(await getText(url, 0)).toBe('answer 3');
});

test('one request for callers asking at once; a slow answer doesn\'t hold up the next request, only its 250 ms start', async () => {
  const base = `http://localhost:${server.port}`;
  const before = hits;
  const [a, b] = await Promise.all([getText(`${base}/same`, 0), getText(`${base}/same`, 0)]);
  expect(a).toBe(b);
  expect(hits).toBe(before + 1);
  const t0 = Date.now();
  const done: string[] = [];
  await Promise.all([
    getText(`${base}/slow`, 0).then(() => done.push('slow')),
    getText(`${base}/fast`, 0).then(() => done.push(`fast ${Date.now() - t0 < 700 ? 'early' : 'late'}`)),
  ]);
  expect(done).toEqual(['fast early', 'slow']);
});
