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
    expiresAt: null
};

function setup(links: Record<string, CachedLink>, now = 1_000_000) {
    const recorded: RawClick[] = [];
    const lookups: string[] = [];
    const cache = new LinkCache();
    const handle = createRedirectHandler({
        cache,
        lookup: slug => {
            lookups.push(slug);
            return links[slug] ?? null;
        },
        clicks: { push: c => recorded.push(c) },
        now: () => now
    });
    const get = (path: string, init?: RequestInit) =>
        handle(new Request(`https://s.example${path}`, init));
    return { get, recorded, lookups, cache };
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
            query: ''
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

    test('only GET and HEAD', () => {
        const res = setup({ abc: LINK }).get('/abc', { method: 'POST' });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
    });

    test('/healthz is not special on the short domain', () => {
        expect(setup({ abc: LINK }).get('/healthz').status).toBe(404);
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
