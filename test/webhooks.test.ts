import { describe, expect, test } from 'bun:test';

import { SIGNALS_WINDOW_MS } from '../src/analytics/classify.ts';
import { ClickBuffer, EXPIRE_INTERVAL_MS } from '../src/analytics/clicks.ts';
import { LinkRepo } from '../src/dashboard/links.ts';
import { openDatabase } from '../src/db/client.ts';
import { isDiscordWebhookUrl, maskDiscordUrl } from '../src/shared/discord.ts';
import {
    DEFAULT_WEBHOOK_SKIP,
    type RawClick,
    type WebhookSkipCategory
} from '../src/shared/types.ts';
import {
    AUTO_DISABLE_AFTER_MS,
    KEEP_FINISHED_MS,
    RETRY_DELAYS_MS,
    STANDARD_BATCH,
    WebhookDeliverer,
    type WebhookFetch
} from '../src/webhooks/deliverer.ts';
import {
    clickEmbed,
    clicksMessage,
    DISCORD_INTERVAL_MS,
    type DiscordMessage,
    discordWaitMs
} from '../src/webhooks/discord.ts';
import { SETTLE_DELAY_MS, SIGNALS_DELAY_MS, WebhookOutbox } from '../src/webhooks/outbox.ts';
import {
    type ClickSnapshot,
    createClickReader,
    type LinkClickedEvent,
    linkClickedEvent,
    LOOKUP_RECHECK_MS,
    LOOKUP_WAIT_MS,
    osVersionOf,
    skipReason
} from '../src/webhooks/payload.ts';
import { generateSecret, parseSecret, sign, signedHeaders } from '../src/webhooks/sign.ts';
import type { ResolveHost } from '../src/webhooks/url.ts';

const SHORT = 'https://s.example';
const DASH = 'https://dash.example';

function setup() {
    const db = openDatabase(':memory:');
    const links = new LinkRepo(db, { invalidate() {} });
    const insertClick = (linkId: number, extra: Record<string, string | number | null> = {}) => {
        const row: Record<string, string | number | null> = {
            link_id: linkId,
            ts: Date.UTC(2026, 9, 17, 12),
            country: 'CA',
            region: 'Ontario',
            city: 'Toronto',
            source: 'X',
            referrer_host: 't.co',
            device: 'mobile',
            browser: 'Safari',
            os: 'iOS',
            ip: '203.0.113.5',
            user_agent: 'Mozilla/5.0',
            visitor_hash: 'abc',
            ...extra
        };
        const columns = Object.keys(row);
        return db
            .query<{ id: number }, (string | number | null)[]>(
                `INSERT INTO clicks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING id`
            )
            .get(...Object.values(row))?.id as number;
    };
    return { db, links, insertClick, read: createClickReader(db) };
}

describe('signing', () => {
    test('matches the Standard Webhooks test vector', () => {
        const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
        expect(
            sign(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1_614_265_330, '{"test": 2432232314}')
        ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    });

    test('generated secrets parse; malformed ones throw', () => {
        const secret = generateSecret();
        expect(secret).toStartWith('whsec_');
        expect(parseSecret(secret)).toHaveLength(32);
        expect(() => parseSecret('nope')).toThrow();
        expect(() => parseSecret('whsec_')).toThrow();
        expect(() => parseSecret('whsec_c2hvcnQ=')).toThrow(/24 to 64 bytes/);
    });

    test('signed headers carry id, timestamp and signature', () => {
        const secret = generateSecret();
        const headers = signedHeaders(secret, 'evt_1', 1000, '{}');
        expect(headers).toEqual({
            'Content-Type': 'application/json',
            'webhook-id': 'evt_1',
            'webhook-timestamp': '1000',
            'webhook-signature': sign(secret, 'evt_1', 1000, '{}')
        });
    });
});

describe('payload', () => {
    test('link.clicked carries the link, click and flags, without IP by default', () => {
        const { links, insertClick, read } = setup();
        const link = links.create({ url: 'https://example.com', slug: 'GitHub', tags: ['dev'] });
        const id = insertClick(link.id, { utm_campaign: 'oct', vpn: 'Tor', via_qr: 1 });
        const click = read(id);
        if (!click?.slug || click.url === null) throw new Error('click not found');
        const event = linkClickedEvent(
            { ...click, slug: click.slug, url: click.url },
            { shortOrigin: SHORT, includeIp: false, now: 0 }
        );
        expect(event).toEqual({
            type: 'link.clicked',
            timestamp: '1970-01-01T00:00:00.000Z',
            data: {
                link: {
                    id: link.id,
                    slug: 'GitHub',
                    shortUrl: 'https://s.example/GitHub',
                    url: 'https://example.com',
                    title: null,
                    tags: ['dev']
                },
                click: {
                    id,
                    ts: '2026-10-17T12:00:00.000Z',
                    country: 'CA',
                    region: 'Ontario',
                    city: 'Toronto',
                    source: 'X',
                    referrerHost: 't.co',
                    qr: true,
                    device: 'mobile',
                    browser: 'Safari',
                    os: 'iOS',
                    osVersion: null,
                    language: null,
                    utm: { source: null, medium: null, campaign: 'oct', term: null, content: null },
                    visitor: 'abc',
                    flags: {
                        bot: null,
                        datacenter: false,
                        vpn: 'Tor',
                        scraper: null,
                        abuseScore: null
                    }
                }
            }
        });
        const withIp = linkClickedEvent(
            { ...click, slug: click.slug, url: click.url },
            { shortOrigin: SHORT, includeIp: true, now: 0 }
        );
        expect(withIp.data.click).toMatchObject({ ip: '203.0.113.5', userAgent: 'Mozilla/5.0' });
    });

    test('a click whose link was deleted reads back with null link fields', () => {
        const { db, links, insertClick, read } = setup();
        const link = links.create({ url: 'https://example.com', slug: 'gone' });
        const id = insertClick(link.id);
        db.query('DELETE FROM links WHERE id = ?').run(link.id);
        expect(read(id)).toMatchObject({ slug: null, url: null, tags: [] });
        expect(read(999_999)).toBeNull();
    });
});

/** The OS version for a click with this OS, UA version and reported platform. */
const v = (os: string | null, osVersion: string | null, platform: string | null) =>
    osVersionOf({ os, os_version: osVersion, platform });

describe('OS version', () => {
    test('the browser-reported platform wins over the user agent', () => {
        expect(v('Windows', null, 'Windows 11')).toBe('11');
        expect(v('Windows', null, 'Windows 10')).toBe('10');
        expect(v('macOS', null, 'macOS 15.1.0')).toBe('15.1.0');
        expect(v('iOS', '18.6', null)).toBe('18.6');
        expect(v('Windows', null, null)).toBeNull();
        // A platform for some other OS is ignored.
        expect(v('Linux', null, 'Windows 11')).toBeNull();
    });
});

describe('skip rules', () => {
    const base = { is_bot: 0, is_datacenter: 0, vpn: null, scraper: null, abuse_score: null };
    const reason = (
        facts: Partial<ClickSnapshot>,
        skip: WebhookSkipCategory[] = DEFAULT_WEBHOOK_SKIP
    ) => skipReason({ ...base, ...facts } as ClickSnapshot, new Set(skip), 25);

    test('defaults skip what the dashboard hides', () => {
        expect(reason({})).toBeNull();
        expect(reason({ is_bot: 1 })).toBe('bot');
        expect(reason({ scraper: 'no JS' })).toBe('scraper');
        expect(reason({ is_datacenter: 1 })).toBe('datacenter');
        expect(reason({ abuse_score: 25 })).toBe('abusive');
        expect(reason({ abuse_score: 24 })).toBeNull();
        // A VPN exit on a hosting network is a person on a VPN.
        expect(reason({ is_datacenter: 1, vpn: 'M247' })).toBeNull();
        expect(reason({ vpn: 'Tor' })).toBeNull();
    });

    test('each category can be turned on or off', () => {
        expect(reason({ is_bot: 1 }, [])).toBeNull();
        expect(reason({ vpn: 'Tor' }, ['vpn'])).toBe('vpn');
        expect(reason({ is_datacenter: 1, vpn: 'M247' }, ['vpn'])).toBe('vpn');
        expect(reason({ is_datacenter: 1 }, ['bot'])).toBeNull();
    });
});

const SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

function raw(linkId: number, extra: Partial<RawClick> = {}): RawClick {
    return {
        linkId,
        ts: Date.now(),
        url: 'https://example.com',
        ip: '203.0.113.5',
        ua: SAFARI,
        referrer: '',
        country: 'CA',
        region: 'Ontario',
        city: 'Toronto',
        qr: false,
        query: '',
        language: 'en-CA',
        timezone: 'America/Toronto',
        latitude: '',
        longitude: '',
        token: null,
        ...extra
    };
}

interface EndpointFields {
    kind?: 'standard' | 'discord';
    url?: string;
    secret?: string | null;
    /** Defaults to true unless tags or links are given. */
    allLinks?: boolean;
    links?: number[];
    tags?: string[];
    skip?: WebhookSkipCategory[];
    includeIp?: boolean;
    enabled?: boolean;
}

interface EventRow {
    id: number;
    endpoint_id: number;
    click_id: number | null;
    event_id: string;
    status: string;
    due_at: number;
    attempts: number;
    last_status: number | null;
    last_error: string | null;
}

type Reply = number | Error | Response;

/** A database with links, the outbox and a deliverer on a fake clock and a fake fetch. */
function pipeline(
    opts: {
        allowPrivate?: boolean;
        resolve?: ResolveHost;
        maxPending?: number;
        lookupPending?: (ip: string) => boolean;
    } = {}
) {
    const { db, links } = setup();
    const clock = { now: 1_000_000 };
    const requests: {
        url: string;
        headers: Record<string, string>;
        body: string;
        tls?: { serverName?: string };
    }[] = [];
    const replies: Reply[] = [];
    const outbox = new WebhookOutbox(db);
    let disabled = 0;
    const fakeFetch: WebhookFetch = (url, init) => {
        requests.push({
            url,
            headers: init.headers as Record<string, string>,
            body: init.body as string,
            tls: (init as { tls?: { serverName?: string } }).tls
        });
        const reply = replies.shift() ?? 200;
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve(
            reply instanceof Response ? reply : new Response('ok', { status: reply })
        );
    };
    const deliverer = new WebhookDeliverer(db, {
        shortOrigin: SHORT,
        dashOrigin: DASH,
        abuseMinScore: 25,
        allowPrivate: opts.allowPrivate ?? true,
        resolve: opts.resolve,
        maxPending: opts.maxPending,
        lookupPending: opts.lookupPending,
        now: () => clock.now,
        onDisable: () => {
            disabled++;
            outbox.refresh();
        },
        fetch: fakeFetch
    });
    const buffer = new ClickBuffer(db, {
        shortHost: 's.example',
        salt: 'test-salt-test-salt',
        webhooks: outbox
    });
    const addEndpoint = (fields: EndpointFields = {}) => {
        const id = db
            .query<{ id: number }, (string | number | null)[]>(
                `INSERT INTO webhook_endpoints (kind, url, secret, all_links, tags, skip, include_ip, enabled, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0) RETURNING id`
            )
            .get(
                fields.kind ?? 'standard',
                fields.url ?? 'https://hooks.example/in',
                fields.secret === undefined ? generateSecret() : fields.secret,
                (fields.allLinks ?? (!fields.tags?.length && !fields.links?.length)) ? 1 : 0,
                JSON.stringify(fields.tags ?? []),
                JSON.stringify(fields.skip ?? DEFAULT_WEBHOOK_SKIP),
                fields.includeIp ? 1 : 0,
                fields.enabled === false ? 0 : 1
            )?.id as number;
        for (const linkId of fields.links ?? []) {
            db.query('INSERT INTO webhook_endpoint_links (endpoint_id, link_id) VALUES (?, ?)').run(
                id,
                linkId
            );
        }
        outbox.refresh();
        return id;
    };
    const events = () => db.query<EventRow, []>('SELECT * FROM webhook_events ORDER BY id').all();
    const endpoint = (id: number) =>
        db
            .query<
                { enabled: number; disabled_reason: string | null; failing_since: number | null },
                [number]
            >('SELECT enabled, disabled_reason, failing_since FROM webhook_endpoints WHERE id = ?')
            .get(id);
    /** Records clicks and flushes them, as the redirect server would. */
    const click = (...clicks: RawClick[]) => {
        for (const c of clicks) buffer.push(c);
        buffer.flush();
    };
    return {
        db,
        links,
        clock,
        requests,
        replies,
        outbox,
        deliverer,
        buffer,
        fakeFetch,
        addEndpoint,
        events,
        endpoint,
        click,
        disabled: () => disabled
    };
}

describe('outbox', () => {
    test('nothing is queued without an enabled endpoint', () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        p.click(raw(link.id));
        p.addEndpoint({ enabled: false });
        p.click(raw(link.id));
        expect(p.outbox.active).toBe(false);
        expect(p.events()).toEqual([]);
    });

    test('one event per endpoint per click, bots dropped where skipped, tags filtered', () => {
        const p = pipeline();
        const tagged = p.links.create({ url: 'https://example.com', tags: ['dev'] });
        const plain = p.links.create({ url: 'https://example.org' });
        const all = p.addEndpoint();
        const dev = p.addEndpoint({ tags: ['dev', 'docs'] });
        const everything = p.addEndpoint({ skip: [] });

        p.click(raw(tagged.id), raw(plain.id), raw(plain.id, { ua: 'Googlebot/2.1' }));
        const count = (id: number) => p.events().filter(e => e.endpoint_id === id).length;
        expect(count(all)).toBe(2);
        expect(count(dev)).toBe(1);
        expect(count(everything)).toBe(3);
        expect(new Set(p.events().map(e => e.event_id)).size).toBe(6);
        expect(p.events().every(e => /^evt_[\da-f]{24}$/.test(e.event_id))).toBe(true);
    });

    test('an endpoint can be for chosen links, tags, both, or nothing yet', () => {
        const p = pipeline();
        const a = p.links.create({ url: 'https://a.example' });
        const b = p.links.create({ url: 'https://b.example', tags: ['promo'] });
        const c = p.links.create({ url: 'https://c.example' });
        const onlyA = p.addEndpoint({ links: [a.id] });
        const aOrPromo = p.addEndpoint({ links: [a.id], tags: ['promo'] });
        const none = p.addEndpoint({ allLinks: false });

        p.click(raw(a.id), raw(b.id), raw(c.id));
        const linksFor = (id: number) =>
            p
                .events()
                .filter(e => e.endpoint_id === id)
                .map(
                    e =>
                        p.db
                            .query<{ link_id: number }, [number]>(
                                'SELECT link_id FROM clicks WHERE id = ?'
                            )
                            .get(e.click_id ?? 0)?.link_id
                );
        expect(linksFor(onlyA)).toEqual([a.id]);
        expect(linksFor(aOrPromo)).toEqual([a.id, b.id]);
        expect(linksFor(none)).toEqual([]);

        // Deleting a link drops it from the endpoints it was chosen for.
        p.links.delete(a.id);
        expect(p.db.query('SELECT COUNT(*) AS n FROM webhook_endpoint_links').get()).toEqual({
            n: 0
        });
    });

    test('endpoints that skip late verdicts wait for them; others are due at once', () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        const settled = p.addEndpoint();
        const quick = p.addEndpoint({ skip: ['bot', 'vpn'] });
        const before = Date.now();
        p.click(raw(link.id));
        const due = (id: number) => p.events().find(e => e.endpoint_id === id)?.due_at ?? 0;
        expect(due(settled)).toBeGreaterThanOrEqual(before + SETTLE_DELAY_MS);
        expect(due(quick)).toBeLessThan(before + SETTLE_DELAY_MS);
    });
});

describe('delivery', () => {
    test('a due event is sent once, signed, and marked delivered', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com', slug: 'gh' });
        const secret = generateSecret();
        p.addEndpoint({ secret, skip: ['bot'] });
        p.click(raw(link.id));
        const [queued] = p.events();
        if (!queued) throw new Error('nothing queued');

        p.clock.now = queued.due_at - 1;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(0);

        p.clock.now = queued.due_at;
        await p.deliverer.tick();
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(1);
        const [req] = p.requests;
        if (!req) throw new Error('no request');
        expect(req.url).toBe('https://hooks.example/in');
        expect(req.headers['webhook-id']).toBe(queued.event_id);
        const ts = Number(req.headers['webhook-timestamp']);
        expect(ts).toBe(Math.floor(queued.due_at / 1000));
        expect(req.headers['webhook-signature']).toBe(sign(secret, queued.event_id, ts, req.body));
        const body = JSON.parse(req.body) as LinkClickedEvent;
        expect(body.type).toBe('link.clicked');
        expect(body.data.link).toMatchObject({ slug: 'gh', shortUrl: 'https://s.example/gh' });
        expect(body.data.click).toMatchObject({ country: 'CA', browser: 'Safari', os: 'iOS' });
        expect(body.data.click).not.toHaveProperty('ip');
        expect(p.events()[0]).toMatchObject({ status: 'delivered', attempts: 1, last_status: 200 });
    });

    test('tracked clicks wait for the device page, so Windows 11 is reported', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com', trackDevice: true });
        p.addEndpoint({ skip: ['bot'] });
        const discord = p.addEndpoint({
            kind: 'discord',
            url: 'https://discord.com/api/webhooks/1/x',
            secret: null,
            skip: ['bot']
        });
        const before = Date.now();
        p.click(
            raw(link.id, {
                token: 'tok-1',
                ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
            })
        );
        expect(p.events().every(e => e.due_at >= before + SIGNALS_DELAY_MS)).toBe(true);

        p.buffer.pushSignals('tok-1', JSON.stringify({ platform: 'Windows 11' }), Date.now());
        p.buffer.flush();
        p.clock.now = Date.now() + SIGNALS_DELAY_MS;
        await p.deliverer.tick();

        const standard = p.requests.find(r => r.url === 'https://hooks.example/in');
        const body = JSON.parse(standard?.body ?? '{}') as LinkClickedEvent;
        expect(body.data.click).toMatchObject({ os: 'Windows', osVersion: '11' });
        const embed = embedsOf(p.requests.find(r => r.url.includes('discord'))?.body)[0];
        expect(embed?.fields?.find(f => f.name === 'Device')?.value).toContain('Windows 11');
        expect(p.events().find(e => e.endpoint_id === discord)?.status).toBe('delivered');
    });

    test('IP and user agent are sent only to endpoints that ask for them', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: [], includeIp: true });
        p.click(raw(link.id));
        p.clock.now = Date.now() + 1;
        await p.deliverer.tick();
        const body = JSON.parse(p.requests[0]?.body ?? '{}') as LinkClickedEvent;
        expect(body.data.click).toMatchObject({ ip: '203.0.113.5', userAgent: SAFARI });
    });

    test('verdicts that land after the click are applied at send time', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint();
        p.click(raw(link.id), raw(link.id, { ip: '198.51.100.7' }));
        p.db.query("UPDATE clicks SET is_datacenter = 1 WHERE ip = '198.51.100.7'").run();
        p.clock.now = Date.now() + SETTLE_DELAY_MS;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(1);
        expect(p.events().map(e => [e.status, e.last_error])).toEqual([
            ['delivered', null],
            ['skipped', 'Skipped: datacenter']
        ]);
    });

    test('events for a deleted link are skipped', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: [] });
        p.click(raw(link.id));
        p.links.delete(link.id);
        p.clock.now = Date.now() + 1;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(0);
        expect(p.events()[0]).toMatchObject({ status: 'skipped', last_error: 'Link was deleted' });
    });

    test("deleting a link leaves its delivered events' log as it was", async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: [] });
        p.click(raw(link.id));
        p.clock.now = Date.now() + 1;
        await p.deliverer.tick();
        const before = p.events();
        p.links.delete(link.id);
        expect(p.events()).toEqual(before.map(e => ({ ...e, click_id: null })));
    });

    test("a deleted link's events never send a click that reused its id", async () => {
        const p = pipeline();
        const a = p.links.create({ url: 'https://a.example' });
        const b = p.links.create({ url: 'https://b.example' });
        p.addEndpoint({ skip: [], links: [a.id] });
        p.click(raw(a.id));
        p.links.delete(a.id);
        p.click(raw(b.id)); // gets the deleted click's id
        p.clock.now = Date.now() + 1;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(0);
        expect(p.events()).toMatchObject([{ click_id: null, status: 'skipped' }]);
    });

    test('failures retry with backoff, then give up', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        const endpoint = p.addEndpoint({ skip: [] });
        p.click(raw(link.id));
        p.clock.now = Date.now() + 1;
        p.replies.push(500, new Error('connect ECONNREFUSED'));

        await p.deliverer.tick();
        expect(p.events()[0]).toMatchObject({
            status: 'pending',
            attempts: 1,
            last_status: 500,
            last_error: 'HTTP 500',
            due_at: p.clock.now + (RETRY_DELAYS_MS[0] ?? 0)
        });
        expect(p.endpoint(endpoint)?.failing_since).toBe(p.clock.now);

        p.clock.now += RETRY_DELAYS_MS[0] ?? 0;
        await p.deliverer.tick();
        expect(p.events()[0]).toMatchObject({
            attempts: 2,
            last_status: null,
            last_error: 'connect ECONNREFUSED'
        });

        // Succeeds on the third try, which ends the failure streak.
        p.clock.now += RETRY_DELAYS_MS[1] ?? 0;
        await p.deliverer.tick();
        expect(p.events()[0]).toMatchObject({ status: 'delivered', attempts: 3 });
        expect(p.endpoint(endpoint)?.failing_since).toBeNull();

        // A second click that never gets through.
        p.click(raw(link.id));
        for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
            p.replies.push(503);
            p.clock.now += 43_200_000;
            await p.deliverer.tick();
        }
        expect(p.events()[1]).toMatchObject({
            status: 'failed',
            attempts: RETRY_DELAYS_MS.length + 1,
            last_status: 503
        });
    });

    test('an endpoint failing for 3 days is turned off and its queue skipped', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        const endpoint = p.addEndpoint({ skip: [] });
        p.click(raw(link.id));
        p.click(raw(link.id));
        p.clock.now = Date.now() + 1;
        p.db
            .query('UPDATE webhook_endpoints SET failing_since = ? WHERE id = ?')
            .run(p.clock.now - AUTO_DISABLE_AFTER_MS, endpoint);
        p.replies.push(500, 500);
        await p.deliverer.tick();
        expect(p.disabled()).toBe(1);
        expect(p.outbox.active).toBe(false);
        expect(p.endpoint(endpoint)).toMatchObject({
            enabled: 0,
            disabled_reason: 'Failing for 3 days'
        });
        expect(p.events().some(e => e.status === 'pending')).toBe(false);
        // Clicks after that queue nothing.
        p.click(raw(link.id));
        expect(p.events()).toHaveLength(2);
    });

    test('URLs on private networks are refused unless allowed', async () => {
        const p = pipeline({ allowPrivate: false, resolve: () => Promise.resolve(['10.0.0.8']) });
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: [], url: 'https://internal.example/hook' });
        p.click(raw(link.id));
        p.clock.now = Date.now() + 1;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(0);
        expect(p.events()[0]).toMatchObject({
            status: 'pending',
            last_error: 'internal.example points at a private network address'
        });
    });

    test('requests go to the address that was checked', async () => {
        const p = pipeline({
            allowPrivate: false,
            resolve: () => Promise.resolve(['93.184.215.14'])
        });
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: [], url: 'https://hooks.example:8443/in?x=1' });
        p.click(raw(link.id));
        p.clock.now = Date.now() + 1;
        await p.deliverer.tick();
        expect(p.requests[0]).toMatchObject({
            url: 'https://93.184.215.14:8443/in?x=1',
            headers: { Host: 'hooks.example:8443' },
            tls: { serverName: 'hooks.example' }
        });
        expect(p.events()[0]?.status).toBe('delivered');
    });

    test('a request that fails after its endpoint was turned off stays skipped', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        const endpoint = p.addEndpoint({ skip: [] });
        p.click(raw(link.id));
        const deliverer: WebhookDeliverer = new WebhookDeliverer(p.db, {
            shortOrigin: SHORT,
            dashOrigin: DASH,
            abuseMinScore: 25,
            allowPrivate: true,
            now: () => Date.now() + 1,
            fetch: () => {
                deliverer.disable(endpoint, 'Turned off');
                return Promise.resolve(new Response(null, { status: 500 }));
            }
        });
        await deliverer.tick();
        expect(p.events()[0]).toMatchObject({ status: 'skipped', attempts: 0 });
    });

    test('a success ends the failure streak', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        const endpoint = p.addEndpoint({ skip: [] });
        p.click(raw(link.id), raw(link.id));
        const now = Date.now() + 1;
        p.db
            .query('UPDATE webhook_endpoints SET failing_since = ? WHERE id = ?')
            .run(now - AUTO_DISABLE_AFTER_MS, endpoint);
        const release: ((status: number) => void)[] = [];
        const deliverer = new WebhookDeliverer(p.db, {
            shortOrigin: SHORT,
            dashOrigin: DASH,
            abuseMinScore: 25,
            allowPrivate: true,
            now: () => now,
            fetch: () =>
                new Promise(resolve => {
                    release.push(status => resolve(new Response(null, { status })));
                })
        });
        const tick = deliverer.tick();
        await Bun.sleep(0);
        release[0]?.(204);
        await Bun.sleep(0);
        release[1]?.(500);
        await tick;
        expect(p.endpoint(endpoint)).toMatchObject({ enabled: 1, failing_since: now });
    });

    test('tracked clicks from hosting IPs wait for the no-JavaScript scraper verdict', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com', trackDevice: true });
        p.addEndpoint({ skip: ['scraper'] });
        p.click(raw(link.id, { token: 'tok-2' }));
        p.db.query('UPDATE clicks SET is_datacenter = 1').run();
        const ts = p.db.query<{ ts: number }, []>('SELECT ts FROM clicks').get()?.ts ?? 0;

        p.clock.now = Date.now() + SETTLE_DELAY_MS;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(0);
        expect(p.events()[0]).toMatchObject({
            status: 'pending',
            attempts: 0,
            due_at: ts + SIGNALS_WINDOW_MS + EXPIRE_INTERVAL_MS
        });

        // The page never reported back, so token expiry labels it a scraper.
        p.db.query("UPDATE clicks SET scraper = 'Skipped JavaScript on a hosting IP'").run();
        p.clock.now = ts + SIGNALS_WINDOW_MS + EXPIRE_INTERVAL_MS;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(0);
        expect(p.events()[0]).toMatchObject({ status: 'skipped', last_error: 'Skipped: scraper' });
    });

    test('clicks wait for a pending reputation lookup before skip rules apply', async () => {
        const pending = new Set(['203.0.113.5']);
        const p = pipeline({ lookupPending: ip => pending.has(ip) });
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: ['datacenter'] });
        p.click(raw(link.id));

        p.clock.now = Date.now() + SETTLE_DELAY_MS;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(0);
        expect(p.events()[0]).toMatchObject({
            status: 'pending',
            attempts: 0,
            due_at: p.clock.now + LOOKUP_RECHECK_MS
        });

        // The lookup lands: a hosting IP.
        pending.clear();
        p.db.query('UPDATE clicks SET is_datacenter = 1, abuse_score = 0').run();
        p.clock.now += LOOKUP_RECHECK_MS;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(0);
        expect(p.events()[0]).toMatchObject({ status: 'skipped', last_error: 'Skipped: datacenter' });
    });

    test('a lookup that never comes holds a click for LOOKUP_WAIT_MS at most', async () => {
        const p = pipeline({ lookupPending: () => true });
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: ['abusive'] });
        p.click(raw(link.id));
        const ts = p.db.query<{ ts: number }, []>('SELECT ts FROM clicks').get()?.ts ?? 0;

        p.clock.now = ts + LOOKUP_WAIT_MS - 1000;
        await p.deliverer.tick();
        expect(p.events()[0]).toMatchObject({ status: 'pending', due_at: ts + LOOKUP_WAIT_MS });

        p.clock.now = ts + LOOKUP_WAIT_MS;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(1);
    });

    test('endpoints that skip nothing the lookup decides do not wait for it', async () => {
        const p = pipeline({ lookupPending: () => true });
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: ['bot'] });
        p.click(raw(link.id));
        p.clock.now = Date.now();
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(1);
    });

    test('at most `concurrency` requests are in flight, one per endpoint', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        for (let i = 0; i < 3; i++) p.addEndpoint({ skip: [] });
        p.click(...Array.from({ length: 5 }, () => raw(link.id)));
        const release: (() => void)[] = [];
        let answer = false;
        const deliverer = new WebhookDeliverer(p.db, {
            shortOrigin: SHORT,
            dashOrigin: DASH,
            abuseMinScore: 25,
            allowPrivate: true,
            concurrency: 2,
            now: () => Date.now() + 1,
            fetch: () =>
                answer
                    ? Promise.resolve(new Response(null, { status: 204 }))
                    : new Promise(resolve => {
                          release.push(() => resolve(new Response(null, { status: 204 })));
                      })
        });
        const first = deliverer.tick();
        await Bun.sleep(0);
        expect(deliverer.stats.inFlight).toBe(2);
        // A tick while full starts nothing.
        await deliverer.tick();
        expect(release).toHaveLength(2);
        answer = true;
        for (const r of release.splice(0)) r();
        await first;
        await deliverer.stop();
        // Each of the two workers drained its endpoint; the third waits for a free slot.
        expect(deliverer.stats.sent).toBe(10);
    });

    test('a busy endpoint hands its slot to the next one after a batch', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: [], url: 'https://a.example/in' });
        p.addEndpoint({ skip: [], url: 'https://b.example/in' });
        p.click(...Array.from({ length: STANDARD_BATCH + 5 }, () => raw(link.id)));
        const hosts: string[] = [];
        const deliverer = new WebhookDeliverer(p.db, {
            shortOrigin: SHORT,
            dashOrigin: DASH,
            abuseMinScore: 25,
            allowPrivate: true,
            concurrency: 1,
            now: () => Date.now() + 1,
            fetch: url => {
                hosts.push(new URL(url).host);
                return Promise.resolve(new Response(null, { status: 204 }));
            }
        });
        await deliverer.tick();
        await deliverer.tick();
        expect(hosts).toHaveLength(2 * STANDARD_BATCH);
        expect(new Set(hosts.slice(0, STANDARD_BATCH)).size).toBe(1);
        expect(hosts[STANDARD_BATCH]).not.toBe(hosts[0]);
    });

    test('a slow endpoint holds one slot, not all of them', async () => {
        const p = pipeline();
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: [], url: 'https://slow.example/in' });
        p.click(...Array.from({ length: 5 }, () => raw(link.id)));
        p.addEndpoint({ skip: [], url: 'https://fast.example/in' });
        p.click(raw(link.id));
        const hosts: string[] = [];
        const deliverer = new WebhookDeliverer(p.db, {
            shortOrigin: SHORT,
            dashOrigin: DASH,
            abuseMinScore: 25,
            allowPrivate: true,
            concurrency: 4,
            now: () => Date.now() + 1,
            fetch: url => {
                hosts.push(new URL(url).host);
                return new Promise(() => {}); // never answers
            }
        });
        void deliverer.tick();
        await Bun.sleep(0);
        expect(hosts.toSorted()).toEqual(['fast.example', 'slow.example']);
    });

    test('maintenance prunes old finished events and caps the pending ones', () => {
        const p = pipeline({ maxPending: 2 });
        const link = p.links.create({ url: 'https://example.com' });
        p.addEndpoint({ skip: [] });
        p.click(raw(link.id), raw(link.id), raw(link.id), raw(link.id));
        p.db
            .query("UPDATE webhook_events SET status = 'delivered', finished_at = 0 WHERE id = 1")
            .run();
        p.deliverer.maintain(KEEP_FINISHED_MS + 1);
        expect(p.events().map(e => [e.id, e.status])).toEqual([
            [2, 'failed'],
            [3, 'pending'],
            [4, 'pending']
        ]);
    });
});

const DISCORD_URL = 'https://discord.com/api/webhooks/123456789/abc-DEF_ghi';

function sampleEvent(overrides: Partial<LinkClickedEvent['data']['click']> = {}): LinkClickedEvent {
    return {
        type: 'link.clicked',
        timestamp: '2026-10-17T12:00:00.000Z',
        data: {
            link: {
                id: 12,
                slug: 'gh',
                shortUrl: 'https://s.example/gh',
                url: 'https://github.com/wkangg',
                title: null,
                tags: []
            },
            click: {
                id: 1,
                ts: '2026-10-17T12:00:00.000Z',
                country: 'CA',
                region: 'Ontario',
                city: 'Toronto',
                source: 'X',
                referrerHost: 't.co',
                qr: false,
                device: 'mobile',
                browser: 'Safari',
                os: 'iOS',
                osVersion: '18.6',
                language: 'en-CA',
                utm: { source: null, medium: null, campaign: null, term: null, content: null },
                visitor: 'abc',
                flags: { bot: null, datacenter: false, vpn: null, scraper: null, abuseScore: null },
                ...overrides
            }
        }
    };
}

describe('discord formatting', () => {
    test('recognizes and masks Discord webhook URLs', () => {
        expect(isDiscordWebhookUrl(DISCORD_URL)).toBe(true);
        expect(isDiscordWebhookUrl('https://discordapp.com/api/webhooks/1/x')).toBe(true);
        expect(isDiscordWebhookUrl('https://canary.discord.com/api/v10/webhooks/1/x')).toBe(true);
        expect(isDiscordWebhookUrl('http://discord.com/api/webhooks/1/x')).toBe(false);
        expect(isDiscordWebhookUrl('https://discord.com/channels/1/2')).toBe(false);
        expect(isDiscordWebhookUrl('https://evil.example/api/webhooks/1/x')).toBe(false);
        expect(maskDiscordUrl(DISCORD_URL)).toBe('https://discord.com/api/webhooks/123456789/••••');
    });

    test('a click becomes one embed with only the fields it has', () => {
        const embed = clickEmbed(sampleEvent(), DASH);
        expect(embed).toMatchObject({
            title: 'Click on s.example/gh',
            url: 'https://dash.example/links/12',
            timestamp: '2026-10-17T12:00:00.000Z',
            footer: { text: '→ https://github.com/wkangg' }
        });
        expect(embed.fields?.map(f => [f.name, f.value])).toEqual([
            ['Location', '🇨🇦 Toronto, Ontario, CA'],
            ['Source', 'X · t.co'],
            ['Device', 'Safari · iOS 18.6 · mobile']
        ]);
        expect(embed).not.toHaveProperty('description');
    });

    test('flags, UTM, QR and opted-in IP fields show up; visitor text is escaped', () => {
        const embed = clickEmbed(
            sampleEvent({
                qr: true,
                referrerHost: '@everyone',
                utm: {
                    source: 'news',
                    medium: null,
                    campaign: '[x](https://evil.example)',
                    term: null,
                    content: null
                },
                flags: { bot: null, datacenter: true, vpn: 'Tor', scraper: null, abuseScore: 80 },
                ip: '203.0.113.5',
                userAgent: '**bold**'
            }),
            DASH
        );
        const fields = Object.fromEntries((embed.fields ?? []).map(f => [f.name, f.value]));
        // Escaped, so Discord shows them as text: no mention, no masked link. (The
        // separator is interpolated: Bun mangles non-ASCII text inside String.raw.)
        const dot = ' · ';
        expect(fields.Source).toBe(String.raw`X${dot}\@everyone`);
        expect(fields.UTM).toBe(
            String.raw`campaign \[x\]\(https\://evil.example\)${dot}source news`
        );
        expect(fields.QR).toBe('Scanned');
        expect(fields.Flags).toBe(String.raw`VPN\: Tor${dot}Datacenter${dot}Abuse 80`);
        expect(fields.IP).toBe('`203.0.113.5`');
        expect(fields['User agent']).toBe(String.raw`\*\*bold\*\*`);
        expect(embed.color).not.toBe(clickEmbed(sampleEvent(), DASH).color);
    });

    test('up to 10 clicks get an embed each; more are summarized', () => {
        const ten = clicksMessage(
            Array.from({ length: 10 }, () => sampleEvent()),
            DASH
        );
        expect(ten.embeds).toHaveLength(10);
        expect(ten.allowed_mentions).toEqual({ parse: [] });

        const many = clicksMessage(
            Array.from({ length: 13 }, (_, i) => sampleEvent({ id: i })),
            DASH
        );
        expect(many.embeds).toHaveLength(10);
        expect(many.embeds[0]).toMatchObject({
            title: '+4 more clicks',
            description: 's.example/gh: 4'
        });
        // The newest nine are shown.
        expect(many.embeds.slice(1).map(e => e.title)).toEqual(
            Array.from({ length: 9 }, () => 'Click on s.example/gh')
        );
    });

    test('rate-limit waits come from the 429 body or the bucket headers', async () => {
        expect(await discordWaitMs(Response.json({ retry_after: 1.5 }, { status: 429 }))).toBe(
            1500
        );
        expect(
            await discordWaitMs(
                new Response(null, { status: 429, headers: { 'retry-after': '3' } })
            )
        ).toBe(3000);
        expect(
            await discordWaitMs(
                new Response(null, {
                    status: 204,
                    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.8' }
                })
            )
        ).toBe(800);
        expect(await discordWaitMs(new Response(null, { status: 204 }))).toBeNull();
    });
});

function discordPipeline() {
    const p = pipeline();
    const link = p.links.create({ url: 'https://example.com', slug: 'gh' });
    const endpoint = p.addEndpoint({
        kind: 'discord',
        url: DISCORD_URL,
        secret: null,
        skip: []
    });
    p.clock.now = Date.now() + 1;
    return { ...p, link, endpointId: endpoint };
}

const embedsOf = (body: string | undefined) => (JSON.parse(body ?? '{}') as DiscordMessage).embeds;

describe('discord delivery', () => {
    test('due clicks go out as one message of embeds', async () => {
        const p = discordPipeline();
        p.click(raw(p.link.id), raw(p.link.id), raw(p.link.id));
        p.replies.push(204);
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(1);
        expect(p.requests[0]?.url).toBe(DISCORD_URL);
        expect(p.requests[0]?.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(embedsOf(p.requests[0]?.body)).toHaveLength(3);
        expect(p.events().map(e => e.status)).toEqual(['delivered', 'delivered', 'delivered']);
    });

    test('messages to one endpoint are at least 2 s apart', async () => {
        const p = discordPipeline();
        p.click(raw(p.link.id));
        await p.deliverer.tick();
        p.click(raw(p.link.id), raw(p.link.id));
        p.clock.now = Date.now() + 1;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(1);
        p.clock.now += DISCORD_INTERVAL_MS;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(2);
        expect(embedsOf(p.requests[1]?.body)).toHaveLength(2);
    });

    test('a 429 waits for retry_after and does not count as an attempt', async () => {
        const p = discordPipeline();
        p.click(raw(p.link.id));
        p.replies.push(Response.json({ retry_after: 30 }, { status: 429 }));
        await p.deliverer.tick();
        expect(p.events()[0]).toMatchObject({ status: 'pending', attempts: 0 });
        p.clock.now += 29_000;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(1);
        p.clock.now += 1000;
        await p.deliverer.tick();
        expect(p.requests).toHaveLength(2);
        expect(p.events()[0]).toMatchObject({ status: 'delivered', attempts: 1 });
    });

    test('a deleted Discord webhook turns the endpoint off', async () => {
        const p = discordPipeline();
        p.click(raw(p.link.id), raw(p.link.id));
        p.replies.push(404);
        await p.deliverer.tick();
        expect(p.endpoint(p.endpointId)).toMatchObject({
            enabled: 0,
            disabled_reason: 'Discord says this webhook no longer exists'
        });
        expect(p.events().map(e => e.status)).toEqual(['skipped', 'skipped']);
        expect(p.outbox.active).toBe(false);
    });

    test('other failures retry like any endpoint', async () => {
        const p = discordPipeline();
        p.click(raw(p.link.id));
        p.replies.push(502);
        await p.deliverer.tick();
        expect(p.events()[0]).toMatchObject({ status: 'pending', attempts: 1, last_status: 502 });
    });

    test('webhook.test events are sent as their own message', async () => {
        const p = discordPipeline();
        p.click(raw(p.link.id));
        p.db
            .query(
                `INSERT INTO webhook_events (endpoint_id, type, event_id, due_at, created_at)
             VALUES (?, 'webhook.test', 'evt_test', 0, 0)`
            )
            .run(p.endpointId);
        await p.deliverer.tick();
        expect(embedsOf(p.requests[0]?.body)[0]?.title).toBe('Webhook connected ✅');
        expect(p.events().map(e => [e.event_id === 'evt_test', e.status])).toEqual([
            [false, 'pending'],
            [true, 'delivered']
        ]);
    });
});
