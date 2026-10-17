import { describe, expect, test } from 'bun:test';

import { LinkRepo } from '../src/dashboard/links.ts';
import { openDatabase } from '../src/db/client.ts';
import { DEFAULT_WEBHOOK_SKIP, type WebhookSkipCategory } from '../src/shared/types.ts';
import {
    type ClickSnapshot,
    createClickReader,
    linkClickedEvent,
    skipReason
} from '../src/webhooks/payload.ts';
import { generateSecret, parseSecret, sign, signedHeaders } from '../src/webhooks/sign.ts';

const SHORT = 'https://s.example';

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
