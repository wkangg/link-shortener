import { afterAll, describe, expect, test } from 'bun:test';

import { testApp } from './helpers.ts';

const t = testApp();
afterAll(() => t.close());

describe('dashboard server', () => {
    test('/healthz', async () => {
        const res = await t.api('/healthz');
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('ok');
    });

    test('/api/health', async () => {
        const res = await t.api('/api/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, version: 'test', db: true });
    });

    test('unknown /api routes return JSON 404, not the SPA', async () => {
        const res = await t.api('/api/nope');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
    });

    test.each(['/', '/links/123', '/settings'])('SPA is served for %s', async path => {
        const res = await t.api(path);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('<div id="root">');
    });
});

describe('redirect server', () => {
    test('serves the redirect handler; root is 404 with no root link', async () => {
        const res = await t.click('/');
        expect(res.status).toBe(404);
    });

    test.each([
        ['with a length', 'x'.repeat(5000)],
        ['streamed', new Blob(['x'.repeat(5000)]).stream()]
    ] as const)('signals bodies over the limit get 413 (%s)', async (_, body) => {
        const res = await fetch(new URL('/_/signals', t.app.short.url), { method: 'POST', body });
        expect(res.status).toBe(413);
    });
});
