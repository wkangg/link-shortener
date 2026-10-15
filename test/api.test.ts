import { afterAll, describe, expect, test } from 'bun:test';

import type {
    ApiError,
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
const SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

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
