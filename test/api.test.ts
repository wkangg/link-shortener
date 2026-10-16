import { afterAll, describe, expect, test } from 'bun:test';
import net from 'node:net';

import type {
    ApiError,
    ClickHistoryResponse,
    ConfigResponse,
    Link,
    LinkListResponse,
    SummaryResponse,
    TopResponse
} from '../src/shared/types.ts';
import { DASH, testApp } from './helpers.ts';

const t = testApp();
afterAll(() => t.close());

const send = (method: string, path: string, body: unknown) =>
    t.api(path, { method, body: JSON.stringify(body) });
const range = () => `from=${Date.now() - 86_400_000}&to=${Date.now() + 60_000}`;
const location = async (path: string) => {
    const res = await t.click(path);
    return res.headers.get('location');
};
const clickStatus = async (path: string) => {
    const res = await t.click(path);
    return res.status;
};
const SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

describe('root link', () => {
    test('slug `/` creates the root link, which redirects and counts clicks', async () => {
        expect(await clickStatus('/')).toBe(404);

        const created = await send('POST', '/api/links', {
            url: 'https://example.org/',
            slug: '/'
        });
        expect(created.status).toBe(201);
        const link = (await created.json()) as Link;
        expect(link.slug).toBe('');

        expect(await location('/')).toBe('https://example.org/');

        const again = await send('POST', '/api/links', { url: 'https://example.net/', slug: '/' });
        expect(again.status).toBe(409);

        // Random slugs still work when the slug is left empty.
        const random = await send('POST', '/api/links', { url: 'https://example.net/', slug: '' });
        expect(((await random.json()) as Link).slug).toMatch(/^[\w-]{6}$/);

        // Moving the root link to a normal slug frees `/`.
        const moved = await send('PATCH', `/api/links/${link.id}`, { slug: 'home' });
        expect(moved.status).toBe(200);
        expect(await clickStatus('/')).toBe(404);
        expect(await location('/home')).toBe('https://example.org/');

        await send('PATCH', `/api/links/${link.id}`, { slug: '/' });
        expect(await location('/')).toBe('https://example.org/');
        expect(t.app.clicks.flush()).toBe(3);
        expect(await t.status(`/api/links/${link.id}`, { method: 'DELETE' })).toBe(204);
        expect(await clickStatus('/')).toBe(404);
    });
});

describe('links API + redirects + analytics, end to end', () => {
    test('create, redirect with pass-through, count, edit, delete', async () => {
        const created = await send('POST', '/api/links', {
            url: 'https://example.com/landing',
            slug: 'e2e',
            tags: ['test']
        });
        expect(created.status).toBe(201);
        const link = (await created.json()) as Link;
        expect(link).toMatchObject({ slug: 'e2e', tags: ['test'] });

        const res = await t.click('/e2e?utm_source=newsletter&ref=ig', {
            'cf-connecting-ip': '9.9.9.9',
            'cf-ipcountry': 'CA',
            'user-agent': SAFARI
        });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(
            'https://example.com/landing?utm_source=newsletter&ref=ig'
        );
        await t.click('/e2e?qr', { 'cf-connecting-ip': '8.8.8.8', 'user-agent': SAFARI });
        await t.click('/e2e', { 'user-agent': 'curl/8.0' }); // a bot: stored, hidden by default
        expect(t.app.clicks.flush()).toBe(3);

        const summary = await t.get<SummaryResponse>(
            `/api/stats/summary?${range()}&link=${link.id}`
        );
        expect(summary).toMatchObject({ clicks: 2, visitors: 2 });

        const sources = await t.get<TopResponse>(`/api/stats/top?dim=source&${range()}`);
        expect(sources.rows.map(r => r.value).toSorted()).toEqual(['QR', 'newsletter']);

        const params = await t.get<TopResponse>(`/api/stats/top?dim=param:ref&${range()}`);
        expect(params.rows[0]?.value).toBe('ig');

        const filtered = await t.get<SummaryResponse>(`/api/stats/summary?${range()}&f=country:CA`);
        expect(filtered.clicks).toBe(1);

        const list = await t.get<LinkListResponse>('/api/links?sort=clicks');
        expect(list.links[0]).toMatchObject({ slug: 'e2e', clicks: 2 });

        // Editing takes effect on the very next redirect (cache invalidated).
        const edited = await send('PATCH', `/api/links/${link.id}`, {
            url: 'https://example.org/'
        });
        expect(edited.status).toBe(200);
        expect(await location('/e2e')).toBe('https://example.org/');

        const history = await t.get<ClickHistoryResponse>(
            `/api/stats/clicks?${range()}&bots=1&limit=2`
        );
        expect(history.clicks).toHaveLength(2);
        expect(history.clicks[0]).toMatchObject({
            slug: 'e2e',
            userAgent: 'curl/8.0',
            bot: true
        });
        expect(history.clicks[1]).toMatchObject({ ip: '8.8.8.8', userAgent: SAFARI, qr: true });
        expect(history.next).toBe(`${history.clicks[1]?.ts}_${history.clicks[1]?.id}`);
        const older = await t.get<ClickHistoryResponse>(
            `/api/stats/clicks?${range()}&bots=1&before=${history.next ?? ''}`
        );
        expect(older.clicks.map(c => c.ip)).toEqual(['9.9.9.9']);
        expect(older.next).toBeNull();
        expect(history.total).toBe(3);
        const page2 = await t.get<ClickHistoryResponse>(
            `/api/stats/clicks?${range()}&bots=1&limit=2&offset=2`
        );
        expect(page2.clicks.map(c => c.ip)).toEqual(['9.9.9.9']);
        expect(page2).toMatchObject({ next: null, total: 3 });
        const byIp = await t.get<ClickHistoryResponse>(`/api/stats/clicks?${range()}&f=ip:9.9.9.9`);
        expect(byIp.clicks).toHaveLength(1);
        expect(await t.status(`/api/stats/clicks?${range()}&before=x`)).toBe(400);

        const csv = await t.api(`/api/export.csv?${range()}`);
        expect(csv.headers.get('content-type')).toContain('text/csv');
        const csvText = await csv.text();
        expect(csvText.split('\n')[0]).toStartWith('time,slug');

        expect(await t.status(`/api/links/${link.id}`, { method: 'DELETE' })).toBe(204);
        const after = await t.click('/e2e');
        expect(after.status).toBe(404);
    });

    test('random slugs, conflicts and validation errors', async () => {
        const created = await send('POST', '/api/links', { url: 'https://a.com' });
        const random = (await created.json()) as Link;
        expect(random.slug).toHaveLength(6);

        await send('POST', '/api/links', { url: 'https://a.com', slug: 'taken' });
        const conflict = await send('POST', '/api/links', { url: 'https://b.com', slug: 'taken' });
        expect(conflict.status).toBe(409);

        const invalid = await send('POST', '/api/links', { url: 'not a url' });
        expect(invalid.status).toBe(400);
        const body = (await invalid.json()) as ApiError;
        expect(body.issues?.length).toBeGreaterThan(0);

        const notJson = await t.api('/api/links', {
            method: 'POST',
            body: 'x',
            headers: { Origin: DASH, 'Content-Type': 'text/plain' }
        });
        expect(notJson.status).toBe(400);
    });

    test('bad stats queries are 400s', async () => {
        expect(await t.status('/api/stats/summary?from=10&to=5')).toBe(400);
        expect(await t.status(`/api/stats/top?dim=nope&${range()}`)).toBe(400);
        expect(await t.status(`/api/stats/summary?${range()}&f=bogus:x`)).toBe(400);
    });

    test('auth and origin checks', async () => {
        expect(await t.status('/api/links/999')).toBe(404);
        const cross = await t.api('/api/links', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://x.com' }),
            headers: { Origin: 'https://evil.example' }
        });
        expect(cross.status).toBe(403);

        t.auth.identity = null;
        expect(await t.status('/api/links')).toBe(401);
        expect(await t.status('/api/health')).toBe(200);
        t.auth.identity = { subject: 'me@example.com' };
    });
});

describe('non-ASCII Cloudflare location headers', () => {
    test('raw UTF-8 bytes in cf-ipcity are stored correctly', async () => {
        await send('POST', '/api/links', { url: 'https://example.com/', slug: 'mtl' });
        const { hostname, port } = t.app.short.url;
        // fetch() can't send non-Latin-1 header bytes, so write the request by hand.
        await new Promise<void>((resolve, reject) => {
            const sock = net.connect(Number(port), hostname, () => {
                sock.write(
                    Buffer.concat([
                        Buffer.from(
                            `GET /mtl HTTP/1.1\r\nHost: s.example\r\nUser-Agent: ${SAFARI}\r\nAccept-Language: fr-CA\r\n`
                        ),
                        Buffer.from('cf-ipcity: Montréal\r\ncf-region: Québec\r\n', 'utf8'),
                        Buffer.from('Connection: close\r\n\r\n')
                    ])
                );
            });
            sock.on('data', () => sock.end());
            sock.on('close', () => resolve());
            sock.on('error', reject);
        });
        t.app.clicks.flush();
        const history = await t.get<ClickHistoryResponse>(`/api/stats/clicks?${range()}&limit=1`);
        expect(history.clicks[0]).toMatchObject({
            slug: 'mtl',
            city: 'Montréal',
            region: 'Québec'
        });
    });
});

describe('detailed device tracking', () => {
    test('tracked link reports signals that land on the click', async () => {
        const created = await send('POST', '/api/links', {
            url: 'https://example.com/dev',
            slug: 'dev',
            trackDevice: true
        });
        const link = (await created.json()) as Link;
        expect(link.trackDevice).toBe(true);

        const page = await t.click('/dev', {
            'user-agent': SAFARI,
            'accept-language': 'en-CA,en;q=0.9',
            'cf-timezone': 'America/Toronto'
        });
        expect(page.status).toBe(200);
        const token = /T="([\w-]+)"/.exec(await page.text())?.[1] ?? '';
        expect(token).not.toBe('');

        const signals = {
            t: token,
            screen: '390x844@3',
            orientation: 'portrait-primary',
            battery: 42,
            charging: false,
            connection: '4g',
            gpu: 'Apple GPU',
            incognito: true,
            adBlocker: false,
            timezone: 'America/Vancouver'
        };
        const post = (body: unknown) =>
            fetch(new URL('/_/signals', t.app.short.url), {
                method: 'POST',
                body: JSON.stringify(body)
            });
        const accepted = await post(signals);
        expect(accepted.status).toBe(204);
        t.app.clicks.flush();
        // The token is single-use.
        await post({ ...signals, battery: 1 });
        t.app.clicks.flush();

        const history = await t.get<ClickHistoryResponse>(
            `/api/stats/clicks?${range()}&f=link:${link.id}&limit=1`
        );
        expect(history.clicks[0]).toMatchObject({
            slug: 'dev',
            language: 'en-CA',
            timezone: 'America/Vancouver',
            screen: '390x844@3',
            orientation: 'portrait-primary',
            battery: 42,
            charging: false,
            connection: '4g',
            gpu: 'Apple GPU',
            incognito: true,
            adBlocker: false
        });
    });
});

describe('IP reputation', () => {
    test('config reports it off by default', async () => {
        expect(await t.get<ConfigResponse>('/api/config')).toMatchObject({
            reputation: false,
            abuseMinScore: 25
        });
    });

    test('clicks from reported and hosting IPs are hidden until asked for', async () => {
        const r = testApp({
            checkIp: ip =>
                Promise.resolve(
                    ip === '203.0.113.7'
                        ? { score: 90, reports: 30, usageType: 'Fixed Line ISP', isp: 'Bad ISP' }
                        : ip === '198.51.100.20'
                          ? {
                                score: 0,
                                reports: 0,
                                usageType: 'Data Center/Web Hosting/Transit',
                                isp: 'Some Cloud'
                            }
                          : { score: 0, reports: 0, usageType: 'Mobile ISP', isp: 'Good Mobile' }
                )
        });
        try {
            expect(await r.get<ConfigResponse>('/api/config')).toMatchObject({
                reputation: true
            });
            const created = await r.api('/api/links', {
                method: 'POST',
                body: JSON.stringify({ url: 'https://example.com/', slug: 'rep' })
            });
            expect(created.status).toBe(201);
            for (const ip of ['203.0.113.7', '198.51.100.20', '192.0.2.44']) {
                const res = await r.click('/rep', { 'cf-connecting-ip': ip, 'user-agent': SAFARI });
                expect(res.status).toBe(302);
            }
            r.app.clicks.flush();
            await Bun.sleep(20);

            const summary = (flags: string) =>
                r.get<SummaryResponse>(`/api/stats/summary?${range()}${flags}`);
            expect(await summary('')).toMatchObject({ clicks: 1 });
            expect(await summary('&abusive=1')).toMatchObject({ clicks: 2 });
            expect(await summary('&dc=1')).toMatchObject({ clicks: 2 });
            expect(await summary('&abusive=1&dc=1')).toMatchObject({ clicks: 3 });

            const history = await r.get<ClickHistoryResponse>(
                `/api/stats/clicks?${range()}&abusive=1&dc=1`
            );
            expect(
                history.clicks
                    .map(c => [c.ip, c.abuseScore, c.isp, c.isDatacenter])
                    .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))
            ).toEqual([
                ['192.0.2.44', 0, 'Good Mobile', false],
                ['198.51.100.20', 0, 'Some Cloud', true],
                ['203.0.113.7', 90, 'Bad ISP', false]
            ]);
        } finally {
            await r.close();
        }
    });
});
