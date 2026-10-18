import { describe, expect, test } from 'bun:test';

import { type CachedLink, LinkCache } from '../src/redirect/cache.ts';
import {
    createRedirectHandler,
    mergeQuery,
    pathOf,
    splitUrl,
    takeQrFlag
} from '../src/redirect/handler.ts';
import type { RawClick } from '../src/shared/types.ts';

const LINK: CachedLink = {
    id: 7,
    url: 'https://example.com/page?a=1',
    status: 302,
    expiresAt: null,
    track: false
};

function setup(links: Record<string, CachedLink>, now = 1_000_000) {
    const recorded: RawClick[] = [];
    const signals: { token: string; body: string; ts: number }[] = [];
    const lookups: string[] = [];
    const cache = new LinkCache();
    const handle = createRedirectHandler({
        cache,
        lookup: slug => {
            lookups.push(slug);
            return links[slug] ?? null;
        },
        clicks: {
            push: c => recorded.push(c),
            pushSignals: (token, body, ts) => signals.push({ token, body, ts })
        },
        isBot: ua => ua.includes('bot'),
        now: () => now
    });
    // Only the signals POST is async.
    const get = (path: string, init?: RequestInit) =>
        handle(new Request(`https://s.example${path}`, init)) as Response;
    /** Status of a POST (only the signals POST is async). */
    const post = async (path: string, body: string) => {
        const res = await handle(new Request(`https://s.example${path}`, { method: 'POST', body }));
        return res.status;
    };
    return { get, post, recorded, signals, lookups, cache };
}

describe('url helpers', () => {
    test.each([
        ['https://s.example/', '/', ''],
        ['https://s.example/abc', '/abc', ''],
        ['https://s.example/abc?qr', '/abc', 'qr'],
        ['http://localhost:3000/a/b?x=1&y=2', '/a/b', 'x=1&y=2'],
        ['https://s.example', '/', '']
    ])('splitUrl(%s)', (url, path, query) => {
        expect(splitUrl(url)).toEqual([path, query]);
        expect(pathOf(url)).toBe(path);
    });

    test('takeQrFlag', () => {
        expect(takeQrFlag('')).toEqual(['', false]);
        expect(takeQrFlag('qr')).toEqual(['', true]);
        expect(takeQrFlag('ref=ig&qr=1&v=2')).toEqual(['ref=ig&v=2', true]);
        expect(takeQrFlag('qrcode=x')).toEqual(['qrcode=x', false]);
    });

    test('mergeQuery: short URL params win', () => {
        expect(mergeQuery('https://x.com/p?a=1&b=2', 'b=3&utm_source=nl')).toBe(
            'https://x.com/p?a=1&b=3&utm_source=nl'
        );
        expect(mergeQuery('https://x.com/p', '')).toBe('https://x.com/p');
    });
});

describe('redirect handler', () => {
    test('root is 404 until a root link exists', () => {
        const { get, recorded } = setup({ abc: LINK });
        expect(get('/').status).toBe(404);
        expect(recorded).toHaveLength(0);
    });

    test('root link redirects and records a click like any other link', () => {
        const { get, recorded } = setup({ '': { ...LINK, id: 9 } });
        const res = get('/?qr&ref=x');
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('https://example.com/page?a=1&ref=x');
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ linkId: 9, qr: true, query: 'ref=x' });
    });

    test('known slug redirects, no-store, and records one click', () => {
        const { get, recorded } = setup({ abc: LINK });
        const res = get('/abc', {
            headers: {
                'user-agent': 'UA',
                referer: 'https://t.co/x',
                'cf-connecting-ip': '1.2.3.4',
                'cf-ipcountry': 'CA',
                'cf-ipcity': 'Toronto'
            }
        });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(LINK.url);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
            linkId: 7,
            ip: '1.2.3.4',
            ua: 'UA',
            referrer: 'https://t.co/x',
            country: 'CA',
            city: 'Toronto',
            qr: false,
            query: '',
            token: null,
            latitude: '',
            longitude: ''
        });
    });

    test('query params pass through and ?qr is stripped and recorded', () => {
        const { get, recorded } = setup({ abc: LINK });
        const res = get('/abc?qr&utm_source=nl');
        expect(res.headers.get('location')).toBe('https://example.com/page?a=1&utm_source=nl');
        expect(recorded[0]?.qr).toBe(true);
        expect(recorded[0]?.query).toBe('utm_source=nl');
    });

    test('uses the configured redirect status', () => {
        const { get } = setup({ p: { ...LINK, status: 301 } });
        expect(get('/p').status).toBe(301);
    });

    test('HEAD redirects but is not counted', () => {
        const { get, recorded } = setup({ abc: LINK });
        expect(get('/abc', { method: 'HEAD' }).status).toBe(302);
        expect(recorded).toHaveLength(0);
    });

    test('unknown and invalid slugs 404; unknown ones are negatively cached', async () => {
        const { get, lookups } = setup({ abc: LINK });
        const res = get('/nope');
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('Not found');
        get('/nope');
        expect(lookups).toEqual(['nope']);
        expect(get('/a.b').status).toBe(404);
        expect(get('/a/b').status).toBe(404);
    });

    test('expired links return 410', () => {
        const { get, recorded } = setup({ old: { ...LINK, expiresAt: 999_999 } });
        expect(get('/old').status).toBe(410);
        expect(recorded).toHaveLength(0);
    });

    test('lookups are cached', () => {
        const { get, lookups } = setup({ abc: LINK });
        get('/abc');
        get('/abc');
        expect(lookups).toEqual(['abc']);
    });

    test('slugs match regardless of case and share one cache entry', () => {
        const { get, lookups, cache } = setup({ GitHub: LINK });
        expect(get('/GitHub').status).toBe(302);
        expect(get('/github').status).toBe(302);
        expect(get('/GITHUB').status).toBe(302);
        expect(lookups).toEqual(['GitHub']);
        cache.invalidate('GITHUB');
        expect(cache.get('github', 0)).toBeUndefined();
    });

    test('only GET and HEAD', () => {
        const res = setup({ abc: LINK }).get('/abc', { method: 'POST' });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
    });

    test('/healthz is not special on the short domain', () => {
        expect(setup({ abc: LINK }).get('/healthz').status).toBe(404);
    });

    test('records language and timezone headers', () => {
        const { get, recorded } = setup({ abc: LINK });
        get('/abc', {
            headers: { 'accept-language': 'fr-CA,fr;q=0.9', 'cf-timezone': 'America/Toronto' }
        });
        expect(recorded[0]).toMatchObject({
            language: 'fr-CA,fr;q=0.9',
            timezone: 'America/Toronto'
        });
    });

    test('records the edge-reported coordinates', () => {
        const { get, recorded } = setup({ abc: LINK });
        get('/abc', { headers: { 'cf-iplatitude': '43.6532', 'cf-iplongitude': '-79.3832' } });
        expect(recorded[0]).toMatchObject({ latitude: '43.6532', longitude: '-79.3832' });
    });
});

describe('device tracking', () => {
    const TRACKED = { ...LINK, track: true, url: 'https://example.com/a?x=</script><b>"' };

    test('tracked links serve the signals page with a token, not a redirect', async () => {
        const { get, recorded } = setup({ t: TRACKED });
        // No query to merge: the destination goes into the page exactly as stored.
        const res = get('/t');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        const token = recorded[0]?.token;
        expect(token).toMatch(/^[\w-]{36}$/);
        const html = await res.text();
        expect(html).toContain(JSON.stringify(token));
        // The destination can't break out of the script or the attribute.
        expect(html).not.toContain('</script><b>');
        expect(html).toContain(
            'content="3;url=https://example.com/a?x=&lt;/script&gt;&lt;b&gt;&quot;"'
        );
    });

    test('bots and HEAD still get the plain redirect', () => {
        const { get, recorded } = setup({ t: TRACKED });
        expect(get('/t', { headers: { 'user-agent': 'Slackbot' } }).status).toBe(302);
        expect(recorded[0]?.token).toBeNull();
        expect(get('/t', { method: 'HEAD' }).status).toBe(302);
    });

    test('signals POST is queued by token', async () => {
        const { post, signals } = setup({});
        const body = JSON.stringify({ t: 'abc-123', battery: 50 });
        expect(await post('/_/signals', body)).toBe(204);
        expect(signals).toEqual([{ token: 'abc-123', body, ts: 1_000_000 }]);
        expect(await post('/_/signals', '{}')).toBe(204);
        expect(signals).toHaveLength(1);
    });
});

describe('LinkCache', () => {
    test('evicts the least recently used entry', () => {
        const cache = new LinkCache(2);
        cache.set('a', LINK, 0);
        cache.set('b', LINK, 0);
        cache.get('a', 0);
        cache.set('c', LINK, 0);
        expect(cache.get('a', 0)).toBe(LINK);
        expect(cache.get('b', 0)).toBeUndefined();
        expect(cache.size).toBe(2);
    });

    test('misses expire after a minute', () => {
        const cache = new LinkCache();
        cache.set('x', null, 0);
        expect(cache.get('x', 59_999)).toBeNull();
        expect(cache.get('x', 60_000)).toBeUndefined();
    });

    test('invalidate forgets hits and misses', () => {
        const cache = new LinkCache();
        cache.set('a', LINK, 0);
        cache.set('b', null, 0);
        cache.invalidate('a');
        cache.invalidate('b');
        expect(cache.get('a', 0)).toBeUndefined();
        expect(cache.get('b', 0)).toBeUndefined();
    });
});
