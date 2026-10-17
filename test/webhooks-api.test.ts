import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { openDatabase } from '../src/db/client.ts';
import type {
    ApiError,
    Link,
    LinkListResponse,
    WebhookEndpoint,
    WebhookEndpointCreated,
    WebhookEventRow,
    WebhookSecretResponse
} from '../src/shared/types.ts';
import { EndpointRepo } from '../src/webhooks/endpoints.ts';
import { WebhookOutbox } from '../src/webhooks/outbox.ts';
import { sign } from '../src/webhooks/sign.ts';
import { WebhookUrlError } from '../src/webhooks/url.ts';
import { testApp } from './helpers.ts';

const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
const replies: number[] = [];
const t = testApp({
    webhookFetch: (url, init) => {
        sent.push({
            url,
            headers: init.headers as Record<string, string>,
            body: init.body as string
        });
        return Promise.resolve(new Response(null, { status: replies.shift() ?? 204 }));
    }
});
afterAll(() => t.close());
beforeEach(() => {
    sent.length = 0;
    replies.length = 0;
    t.db.run('DELETE FROM webhook_endpoints');
    t.app.outbox.refresh();
});

const DISCORD_URL = 'https://discord.com/api/webhooks/123456789/abc-DEF_ghi';

async function send<T>(
    method: string,
    path: string,
    body?: unknown
): Promise<{ status: number; body: T }> {
    const res = await t.api(path, {
        method,
        ...(body !== undefined && { body: JSON.stringify(body) })
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function statusOf(method: string, path: string, body?: unknown): Promise<number> {
    const res = await send(method, path, body);
    return res.status;
}

const create = (body: Record<string, unknown>) =>
    send<WebhookEndpointCreated>('POST', '/api/webhooks', body);

describe('webhook endpoints API', () => {
    test('needs auth', async () => {
        t.auth.identity = null;
        try {
            expect(await t.status('/api/webhooks')).toBe(401);
        } finally {
            t.auth.identity = { subject: 'me@example.com' };
        }
    });

    test('create shows the secret once; reads never include it', async () => {
        const created = await create({ url: 'https://hooks.example/in', description: 'Zapier' });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
            kind: 'standard',
            url: 'https://hooks.example/in',
            description: 'Zapier',
            enabled: true,
            allLinks: true,
            links: [],
            tags: [],
            skip: ['bot', 'datacenter', 'scraper', 'abusive'],
            includeIp: false,
            counts: { pending: 0, delivered: 0, skipped: 0, failed: 0 },
            lastEvent: null
        });
        expect(created.body.secret).toMatch(/^whsec_/);

        const list = await send<WebhookEndpoint[]>('GET', '/api/webhooks');
        expect(list.body).toHaveLength(1);
        expect(list.body[0]).not.toHaveProperty('secret');
        const one = await send<WebhookEndpoint>('GET', `/api/webhooks/${created.body.id}`);
        expect(one.body).not.toHaveProperty('secret');
        expect(t.app.outbox.active).toBe(true);
    });

    test('Discord URLs are detected, need no secret and come back masked', async () => {
        const created = await create({ url: DISCORD_URL });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
            kind: 'discord',
            url: 'https://discord.com/api/webhooks/123456789/••••',
            secret: null
        });
        const list = await send<WebhookEndpoint[]>('GET', '/api/webhooks');
        expect(JSON.stringify(list.body)).not.toContain('abc-DEF_ghi');

        const rotate = await send<ApiError>('POST', `/api/webhooks/${created.body.id}/secret`);
        expect(rotate.status).toBe(400);
    });

    test('bad input is rejected with field errors', async () => {
        const notUrl = await send<ApiError>('POST', '/api/webhooks', { url: 'nope' });
        expect(notUrl.status).toBe(400);
        expect(notUrl.body.issues?.[0]?.path).toBe('url');

        const ftp = await send<ApiError>('POST', '/api/webhooks', { url: 'ftp://hooks.example' });
        expect(ftp.status).toBe(400);

        const notDiscord = await send<ApiError>('POST', '/api/webhooks', {
            url: 'https://hooks.example/in',
            kind: 'discord'
        });
        expect(notDiscord.status).toBe(400);
        expect(notDiscord.body.error).toContain('discord.com/api/webhooks');

        const badSkip = await send<ApiError>('POST', '/api/webhooks', {
            url: 'https://hooks.example/in',
            skip: ['humans']
        });
        expect(badSkip.status).toBe(400);
        expect(badSkip.body.issues?.[0]?.path).toBe('skip.0');

        const extra = await send<ApiError>('POST', '/api/webhooks', {
            url: 'https://hooks.example/in',
            secret: 'whsec_x'
        });
        expect(extra.status).toBe(400);
    });

    test('update, turn off (skipping the queue) and back on', async () => {
        const created = await create({ url: 'https://hooks.example/in', skip: [] });
        const id = created.body.id;
        const updated = await send<WebhookEndpoint>('PATCH', `/api/webhooks/${id}`, {
            description: 'CRM',
            tags: ['Promo', 'promo'],
            skip: ['bot', 'vpn'],
            includeIp: true
        });
        expect(updated.body).toMatchObject({
            description: 'CRM',
            tags: ['promo'],
            skip: ['bot', 'vpn'],
            includeIp: true
        });

        t.db
            .query(
                `INSERT INTO webhook_events (endpoint_id, event_id, due_at, created_at)
             VALUES (?, 'evt_x', 9e15, 0)`
            )
            .run(id);
        t.db
            .query(
                "UPDATE webhook_endpoints SET disabled_reason = 'x', failing_since = 1 WHERE id = ?"
            )
            .run(id);
        const off = await send<WebhookEndpoint>('PATCH', `/api/webhooks/${id}`, { enabled: false });
        expect(off.body).toMatchObject({ enabled: false, counts: { pending: 0, skipped: 1 } });
        expect(t.app.outbox.active).toBe(false);

        const on = await send<WebhookEndpoint>('PATCH', `/api/webhooks/${id}`, { enabled: true });
        expect(on.body).toMatchObject({ enabled: true, disabledReason: null, failingSince: null });
        expect(t.app.outbox.active).toBe(true);

        expect(await statusOf('PATCH', '/api/webhooks/999', { enabled: true })).toBe(404);
    });

    test('an endpoint can be limited to chosen links, and links toggled one at a time', async () => {
        const a = await send<Link>('POST', '/api/links', { url: 'https://a.example', slug: 'wa' });
        const b = await send<Link>('POST', '/api/links', { url: 'https://b.example', slug: 'wb' });

        const created = await create({ url: 'https://hooks.example/in', links: [a.body.id] });
        expect(created.body).toMatchObject({
            allLinks: false,
            links: [{ id: a.body.id, slug: 'wa' }],
            tags: []
        });
        const id = created.body.id;

        const added = await send<WebhookEndpoint>('PUT', `/api/webhooks/${id}/links/${b.body.id}`);
        expect(added.body.links.map(l => l.slug)).toEqual(['wa', 'wb']);
        const removed = await send<WebhookEndpoint>(
            'DELETE',
            `/api/webhooks/${id}/links/${a.body.id}`
        );
        expect(removed.body.links.map(l => l.slug)).toEqual(['wb']);
        // Removing the last link leaves it for no links, not every link.
        const empty = await send<WebhookEndpoint>(
            'DELETE',
            `/api/webhooks/${id}/links/${b.body.id}`
        );
        expect(empty.body).toMatchObject({ allLinks: false, links: [] });

        const replaced = await send<WebhookEndpoint>('PATCH', `/api/webhooks/${id}`, {
            links: [b.body.id, a.body.id]
        });
        expect(replaced.body.links.map(l => l.slug)).toEqual(['wa', 'wb']);
        const all = await send<WebhookEndpoint>('PATCH', `/api/webhooks/${id}`, { allLinks: true });
        expect(all.body.allLinks).toBe(true);
        expect(await statusOf('PUT', `/api/webhooks/${id}/links/${a.body.id}`)).toBe(409);

        const missing = await send<ApiError>('POST', '/api/webhooks', {
            url: 'https://hooks.example/in',
            links: [999_999]
        });
        expect(missing.status).toBe(400);
        expect(missing.body.error).toContain('999999');
        expect(
            await statusOf('PATCH', `/api/webhooks/${id}`, { allLinks: false, links: [999_999] })
        ).toBe(400);
        await send('PATCH', `/api/webhooks/${id}`, { allLinks: false });
        expect(await statusOf('PUT', `/api/webhooks/${id}/links/999999`)).toBe(400);
        expect(await statusOf('PUT', `/api/webhooks/999999/links/${a.body.id}`)).toBe(404);

        expect(await statusOf('DELETE', `/api/links/${a.body.id}`)).toBe(204);
        expect(await statusOf('DELETE', `/api/links/${b.body.id}`)).toBe(204);
    });

    test('the links list says which webhooks each link was chosen for', async () => {
        const a = await send<Link>('POST', '/api/links', { url: 'https://a.example', slug: 'la' });
        const b = await send<Link>('POST', '/api/links', {
            url: 'https://b.example',
            slug: 'lb',
            tags: ['launch']
        });
        const c = await send<Link>('POST', '/api/links', { url: 'https://c.example', slug: 'lc' });
        const direct = await create({ url: 'https://hooks.example/a', links: [a.body.id] });
        const tagged = await create({
            url: 'https://hooks.example/b',
            description: 'Launch',
            tags: ['launch'],
            links: [b.body.id]
        });
        const every = await create({ url: 'https://zap.example/every', description: 'Zapier' });
        await send('PATCH', `/api/webhooks/${tagged.body.id}`, { enabled: false });

        const list = await send<LinkListResponse>('GET', '/api/links?limit=500');
        const of = (id: number) => list.body.links.find(l => l.id === id)?.webhooks;
        const zapier = { id: every.body.id, name: 'Zapier', enabled: true, allLinks: true };
        expect(of(a.body.id)).toEqual([
            { id: direct.body.id, name: 'hooks.example', enabled: true, allLinks: false },
            zapier
        ]);
        // Chosen directly and by tag: listed once.
        expect(of(b.body.id)).toEqual([
            { id: tagged.body.id, name: 'Launch', enabled: false, allLinks: false },
            zapier
        ]);
        // Webhooks for every link show under every link.
        expect(of(c.body.id)).toEqual([zapier]);

        for (const link of [a, b, c]) await send('DELETE', `/api/links/${link.body.id}`);
    });

    test('the links search finds links by webhook and by tracking', async () => {
        const a = await send<Link>('POST', '/api/links', {
            url: 'https://a.example',
            slug: 'sa',
            trackDevice: true
        });
        const b = await send<Link>('POST', '/api/links', {
            url: 'https://b.example',
            slug: 'sb',
            tags: ['launch']
        });
        const c = await send<Link>('POST', '/api/links', { url: 'https://c.example', slug: 'sc' });
        await create({
            url: 'https://hooks.example/a',
            description: 'Promo launch',
            links: [a.body.id]
        });
        await create({ url: DISCORD_URL, tags: ['launch'] });

        const slugs = async (q: string) => {
            const res = await send<LinkListResponse>(
                'GET',
                `/api/links?limit=500&q=${encodeURIComponent(q)}`
            );
            return res.body.links
                .map(l => l.slug)
                .filter(s => ['sa', 'sb', 'sc'].includes(s))
                .toSorted();
        };
        expect(await slugs('has:webhook')).toEqual(['sa', 'sb']);
        expect(await slugs('-has:webhook')).toEqual(['sc']);
        expect(await slugs('webhook:promo')).toEqual(['sa']);
        expect(await slugs('webhook:"promo launch"')).toEqual(['sa']);
        expect(await slugs('webhook:discord')).toEqual(['sb']);
        expect(await slugs('webhook:hooks.example')).toEqual(['sa']);
        expect(await slugs('is:tracked')).toEqual(['sa']);
        // A field with nothing after it yet (typing) filters nothing.
        expect(await slugs('is:')).toEqual(['sa', 'sb', 'sc']);
        expect(await slugs('is:tracked webhook:')).toEqual(['sa']);
        expect(await slugs('-is:tracked has:webhook')).toEqual(['sb']);
        // A webhook for every link gives every link a webhook.
        const every = await create({ url: 'https://zap.example/every', description: 'Zapier' });
        expect(await slugs('has:webhook')).toEqual(['sa', 'sb', 'sc']);
        expect(await slugs('-has:webhook')).toEqual([]);
        expect(await slugs('webhook:zap')).toEqual(['sa', 'sb', 'sc']);
        await send('DELETE', `/api/webhooks/${every.body.id}`);
        // Plain words still match slug, destination and title.
        expect(await slugs('b.example')).toEqual(['sb']);
        expect(await slugs('https://c.example')).toEqual(['sc']);

        const bad = await send<ApiError>('GET', '/api/links?q=is:nope');
        expect(bad.status).toBe(400);
        expect(bad.body.error).toContain('is:tracked');

        for (const link of [a, b, c]) await send('DELETE', `/api/links/${link.body.id}`);
    });

    test('rotating the secret replaces it', async () => {
        const created = await create({ url: 'https://hooks.example/in' });
        const rotated = await send<WebhookSecretResponse>(
            'POST',
            `/api/webhooks/${created.body.id}/secret`
        );
        expect(rotated.status).toBe(200);
        expect(rotated.body.secret).toMatch(/^whsec_/);
        expect(rotated.body.secret).not.toBe(created.body.secret);
    });

    test('a test event is signed with the endpoint secret and shows in the log', async () => {
        const created = await create({ url: 'https://hooks.example/in' });
        const id = created.body.id;
        const queued = await send<WebhookEventRow>('POST', `/api/webhooks/${id}/test`);
        expect(queued.status).toBe(202);
        expect(queued.body).toMatchObject({ type: 'webhook.test', status: 'pending' });

        await t.app.webhooks.tick();
        expect(sent).toHaveLength(1);
        const [req] = sent;
        if (!req || !created.body.secret) throw new Error('not sent');
        expect(JSON.parse(req.body)).toMatchObject({ type: 'webhook.test' });
        const ts = Number(req.headers['webhook-timestamp']);
        expect(req.headers['webhook-signature']).toBe(
            sign(created.body.secret, queued.body.eventId, ts, req.body)
        );

        const events = await send<WebhookEventRow[]>('GET', `/api/webhooks/${id}/events`);
        expect(events.body.map(e => [e.type, e.status, e.httpStatus])).toEqual([
            ['webhook.test', 'delivered', 204]
        ]);
        const endpoint = await send<WebhookEndpoint>('GET', `/api/webhooks/${id}`);
        expect(endpoint.body.lastEvent).toMatchObject({ status: 'delivered', httpStatus: 204 });
        expect(endpoint.body.counts.delivered).toBe(1);

        await send('PATCH', `/api/webhooks/${id}`, { enabled: false });
        expect(await statusOf('POST', `/api/webhooks/${id}/test`)).toBe(409);
    });

    test('a failed event can be retried', async () => {
        const created = await create({ url: 'https://hooks.example/in' });
        const id = created.body.id;
        const queued = await send<WebhookEventRow>('POST', `/api/webhooks/${id}/test`);
        expect(await statusOf('POST', `/api/webhook-events/${queued.body.id}/retry`)).toBe(409);

        t.db
            .query(
                "UPDATE webhook_events SET status = 'failed', attempts = 7, finished_at = 1 WHERE id = ?"
            )
            .run(queued.body.id);
        const retried = await send<WebhookEventRow>(
            'POST',
            `/api/webhook-events/${queued.body.id}/retry`
        );
        expect(retried.body).toMatchObject({ status: 'pending', attempts: 0, finishedAt: null });
        await t.app.webhooks.tick();
        expect(sent).toHaveLength(1);
        expect(await statusOf('POST', '/api/webhook-events/999/retry')).toBe(404);
    });

    test('delete removes the endpoint and its events', async () => {
        const created = await create({ url: 'https://hooks.example/in' });
        await send('POST', `/api/webhooks/${created.body.id}/test`);
        expect(await statusOf('DELETE', `/api/webhooks/${created.body.id}`)).toBe(204);
        expect(await statusOf('GET', `/api/webhooks/${created.body.id}`)).toBe(404);
        expect(t.db.query('SELECT COUNT(*) AS n FROM webhook_events').get()).toEqual({ n: 0 });
        expect(t.app.outbox.active).toBe(false);
    });

    test('a click reaches the endpoint end to end', async () => {
        await create({ url: 'https://hooks.example/in', skip: ['bot'] });
        const link = await send<Link>('POST', '/api/links', {
            url: 'https://example.com/landing',
            slug: 'hooked'
        });
        await t.click('/hooked', {
            'cf-connecting-ip': '9.9.9.9',
            'cf-ipcountry': 'CA',
            'user-agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
        });
        t.app.clicks.flush();
        await t.app.webhooks.tick();
        expect(sent).toHaveLength(1);
        expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({
            type: 'link.clicked',
            data: {
                link: { id: link.body.id, slug: 'hooked', shortUrl: 'https://s.example/hooked' },
                click: { country: 'CA', browser: 'Safari' }
            }
        });
    });
});

/** The WebhookUrlError message a promise rejects with, or null if it resolves. */
const refusal = (pending: Promise<unknown>) =>
    pending.then(
        () => null,
        (error: unknown) => (error instanceof WebhookUrlError ? error.message : error)
    );

describe('endpoint URL checks in production', () => {
    test('URLs that resolve to private addresses are refused', async () => {
        const db = openDatabase(':memory:');
        const repo = new EndpointRepo(db, new WebhookOutbox(db), {
            allowPrivate: false,
            resolve: host =>
                Promise.resolve(host === 'internal.example' ? ['192.168.1.10'] : ['93.184.215.14'])
        });
        expect(await refusal(repo.create({ url: 'https://internal.example/hook' }))).toBe(
            'internal.example points at a private network address'
        );
        // IP addresses are checked as they are, without a lookup.
        expect(await refusal(repo.create({ url: 'http://127.0.0.1:8080/hook' }))).toBe(
            '127.0.0.1 points at a private network address'
        );
        expect(await refusal(repo.create({ url: 'http://[::1]/hook' }))).toBe(
            '::1 points at a private network address'
        );
        const ok = await repo.create({ url: 'https://hooks.example/in' });
        expect(await refusal(repo.update(ok.id, { url: 'https://internal.example/x' }))).toBe(
            'internal.example points at a private network address'
        );
        db.close();
    });
});
