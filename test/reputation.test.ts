import { describe, expect, test } from 'bun:test';

import { ClickBuffer, type ReverseDns } from '../src/analytics/clicks.ts';
import { backfillDatacenterHostnames } from '../src/analytics/datacenter.ts';
import {
    createAbuseIpdb,
    IpReputation,
    parseCheck,
    RateLimitedError,
    type Reputation
} from '../src/analytics/reputation.ts';
import { Stats } from '../src/analytics/stats.ts';
import { openDatabase } from '../src/db/client.ts';
import type { RawClick, StatsQuery } from '../src/shared/types.ts';

const T0 = Date.UTC(2026, 9, 10, 12);
const HOUR = 3_600_000;

const ABUSER = '203.0.113.7';
const HOSTING = '198.51.100.20';
const HOME = '192.0.2.44';

const REPUTATIONS: Record<string, Reputation> = {
    [ABUSER]: { score: 87, reports: 412, usageType: 'Fixed Line ISP', isp: 'Shady Broadband' },
    [HOSTING]: {
        score: 0,
        reports: 0,
        usageType: 'Data Center/Web Hosting/Transit',
        isp: 'Example Cloud'
    },
    [HOME]: { score: 0, reports: 0, usageType: 'Fixed Line ISP', isp: 'Friendly Telecom' }
};

/** Resolves once pending lookups (resolved promises) and their callbacks have run. */
const settle = () => Bun.sleep(5);

const click = (ip: string, ts = T0): RawClick => ({
    linkId: 1,
    ts,
    url: 'https://a.com',
    ip,
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36',
    referrer: '',
    country: 'CA',
    region: '',
    city: '',
    continent: '',
    regionCode: '',
    postalCode: '',
    metroCode: '',
    ray: '',
    asn: '',
    asOrg: '',
    qr: false,
    query: '',
    language: '',
    timezone: '',
    token: null,
    latitude: '',
    longitude: ''
});

function setup(opts: { dailyLimit?: number; now?: () => number; reverseDns?: ReverseDns } = {}) {
    const db = openDatabase(':memory:');
    db.run(
        "INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'a', 'https://a.com', 0, 0)"
    );
    const checked: string[] = [];
    let failNext: Error | null = null;
    const reputation = new IpReputation(db, {
        check: ip => {
            checked.push(ip);
            if (failNext) {
                const error = failNext;
                failNext = null;
                return Promise.reject(error);
            }
            const known = REPUTATIONS[ip];
            return known ? Promise.resolve(known) : Promise.reject(new Error('unknown ip'));
        },
        now: opts.now ?? (() => T0),
        dailyLimit: opts.dailyLimit
    });
    const clicks = new ClickBuffer(db, {
        shortHost: 's.example',
        salt: 'salt',
        reputation,
        reverseDns: opts.reverseDns
    });
    const rows = () =>
        db
            .query<{ ip: string; abuse_score: number | null; isp: string | null; dc: number }, []>(
                'SELECT ip, abuse_score, isp, is_datacenter AS dc FROM clicks ORDER BY id'
            )
            .all();
    return {
        db,
        reputation,
        clicks,
        rows,
        checked,
        failWith: (error: Error) => {
            failNext = error;
        }
    };
}

describe('parseCheck', () => {
    test('reads and clamps the AbuseIPDB fields', () => {
        expect(
            parseCheck({
                abuseConfidenceScore: 100,
                totalReports: 9,
                usageType: 'Data Center/Web Hosting/Transit',
                isp: '  DigitalOcean LLC '
            })
        ).toEqual({
            score: 100,
            reports: 9,
            usageType: 'Data Center/Web Hosting/Transit',
            isp: 'DigitalOcean LLC'
        });
        expect(parseCheck({ abuseConfidenceScore: 400, usageType: '', isp: 5 })).toEqual({
            score: 100,
            reports: 0,
            usageType: null,
            isp: null
        });
        expect(parseCheck({})).toEqual({ score: 0, reports: 0, usageType: null, isp: null });
    });
});

describe('createAbuseIpdb', () => {
    test('sends the key, parses the response, and maps 429 to a rate limit', async () => {
        const seen: { ip: string | null; key: string | null }[] = [];
        const server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);
                const ip = url.searchParams.get('ipAddress');
                seen.push({ ip, key: req.headers.get('key') });
                if (ip === '203.0.113.1') {
                    return new Response('{}', { status: 429, headers: { 'Retry-After': '120' } });
                }
                if (ip === '203.0.113.2') return new Response('nope', { status: 401 });
                return Response.json({
                    data: {
                        ipAddress: ip,
                        abuseConfidenceScore: 73,
                        totalReports: 12,
                        usageType: 'Data Center/Web Hosting/Transit',
                        isp: 'Example Hosting'
                    }
                });
            }
        });
        try {
            const check = createAbuseIpdb('secret-key', { baseUrl: server.url.origin });
            expect(await check('198.51.100.9')).toEqual({
                score: 73,
                reports: 12,
                usageType: 'Data Center/Web Hosting/Transit',
                isp: 'Example Hosting'
            });
            expect(seen[0]).toEqual({ ip: '198.51.100.9', key: 'secret-key' });

            const before = Date.now();
            const limited = await check('203.0.113.1').catch((error: unknown) => error);
            expect(limited).toBeInstanceOf(RateLimitedError);
            expect((limited as RateLimitedError).retryAt).toBeGreaterThanOrEqual(before + 120_000);
            const unauthorized = await check('203.0.113.2').catch((error: unknown) => error);
            expect(unauthorized).toBeInstanceOf(Error);
            expect((unauthorized as Error).message).toContain('401');
        } finally {
            await server.stop(true);
        }
    });
});

describe('IpReputation', () => {
    test('new clicks are checked once per IP and every click from the IP is updated', async () => {
        const t = setup();
        for (const ip of [ABUSER, ABUSER, HOSTING, HOME]) t.clicks.push(click(ip));
        t.clicks.flush();
        await settle();

        expect(t.checked.toSorted()).toEqual([ABUSER, HOME, HOSTING].toSorted());
        expect(t.rows()).toEqual([
            { ip: ABUSER, abuse_score: 87, isp: 'Shady Broadband', dc: 0 },
            { ip: ABUSER, abuse_score: 87, isp: 'Shady Broadband', dc: 0 },
            { ip: HOSTING, abuse_score: 0, isp: 'Example Cloud', dc: 1 },
            { ip: HOME, abuse_score: 0, isp: 'Friendly Telecom', dc: 0 }
        ]);

        // A later click from a known IP gets the cached result at insert, without a lookup.
        t.clicks.push(click(ABUSER, T0 + HOUR));
        t.clicks.flush();
        await settle();
        expect(t.checked.filter(ip => ip === ABUSER)).toHaveLength(1);
        expect(t.rows().at(-1)).toMatchObject({ abuse_score: 87 });
    });

    test('private and invalid addresses are never sent', async () => {
        const t = setup();
        for (const ip of ['10.0.0.1', '192.168.1.5', '127.0.0.1', '::1', 'not-an-ip']) {
            t.clicks.push(click(ip));
        }
        t.clicks.flush();
        await settle();
        expect(t.checked).toEqual([]);
    });

    test('the daily limit holds, counting checks already stored today', async () => {
        const t = setup({ dailyLimit: 2 });
        for (const ip of [ABUSER, HOSTING, HOME]) t.clicks.push(click(ip));
        t.clicks.flush();
        await settle();
        expect(t.checked).toHaveLength(2);
        expect(t.reputation.stats.queued).toBe(1);
        t.reputation.stop();

        // After a restart, today's two checks still count against the limit.
        const again = new IpReputation(t.db, {
            check: () => Promise.reject(new Error('should not be called')),
            now: () => T0 + HOUR,
            dailyLimit: 2
        });
        again.request(HOME);
        await settle();
        expect(again.stats).toMatchObject({ known: 2, queued: 1, inFlight: 0 });
        again.stop();
    });

    test('a rate limit pauses lookups and keeps the IP queued', async () => {
        const t = setup();
        t.failWith(new RateLimitedError(T0 + HOUR));
        t.clicks.push(click(ABUSER));
        t.clicks.flush();
        await settle();
        expect(t.checked).toEqual([ABUSER]);
        expect(t.reputation.stats.queued).toBe(1);
        expect(t.rows()[0]?.abuse_score).toBeNull();
        t.reputation.stop();
    });

    test('backfill copies cached results and checks the busiest unchecked IPs', async () => {
        const t = setup();
        // Clicks recorded before reputation existed: two from ABUSER, one from HOME.
        const insert = t.db.query(
            "INSERT INTO clicks (link_id, ts, source, ip, is_bot) VALUES (1, ?, 'Direct', ?, ?)"
        );
        insert.run(T0 - HOUR, ABUSER, 0);
        insert.run(T0 - HOUR, ABUSER, 0);
        insert.run(T0 - HOUR, HOME, 0);
        insert.run(T0 - HOUR, HOSTING, 1); // bots don't spend quota
        insert.run(T0 - 60 * 24 * HOUR, '203.0.113.99', 0); // too old

        expect(t.reputation.backfill()).toBe(2);
        await settle();
        expect(t.checked).toEqual([ABUSER, HOME]);
        expect(t.rows().map(r => r.abuse_score)).toEqual([87, 87, 0, null, null]);
        // Nothing left to do.
        expect(t.reputation.backfill()).toBe(0);
    });

    test('a later reverse-DNS answer keeps the datacenter flag from the lookup', async () => {
        // A scanner with its own rDNS name, not on the hostname list.
        const t = setup({ reverseDns: () => Promise.resolve('joy.probe.scanner.example') });
        t.clicks.push(click(HOSTING));
        t.clicks.flush();
        await settle();
        t.clicks.flush(); // writes the hostname
        expect(t.rows()).toEqual([{ ip: HOSTING, abuse_score: 0, isp: 'Example Cloud', dc: 1 }]);
    });

    test('backfill restores datacenter flags that reverse DNS overwrote', async () => {
        const t = setup();
        t.clicks.push(click(HOSTING));
        t.clicks.flush();
        await settle();
        t.db.run('UPDATE clicks SET is_datacenter = 0');
        t.reputation.backfill();
        expect(t.rows()[0]?.dc).toBe(1);
    });
});

describe('abuse filter', () => {
    const db = openDatabase(':memory:');
    db.run(
        "INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'a', 'https://a.com', 0, 0)"
    );
    const insert = db.query(
        "INSERT INTO clicks (link_id, ts, source, abuse_score) VALUES (1, ?, 'Direct', ?)"
    );
    insert.run(T0, null); // not checked
    insert.run(T0, 0);
    insert.run(T0, 24);
    insert.run(T0, 25);
    insert.run(T0, 100);
    const q = (overrides: Partial<StatsQuery> = {}): StatsQuery => ({
        from: T0 - HOUR,
        to: T0 + HOUR,
        tz: 0,
        filters: [],
        ...overrides
    });

    test('reported IPs are hidden by default, at the configured score', () => {
        expect(new Stats(db).summary(q()).clicks).toBe(3);
        expect(new Stats(db).summary(q({ abusive: true })).clicks).toBe(5);
        expect(new Stats(db, { abuseMinScore: 90 }).summary(q()).clicks).toBe(4);
    });

    test('history includes the score and ISP', () => {
        const rows = new Stats(db).history(q({ abusive: true })).clicks;
        expect(rows.map(r => r.abuseScore ?? -1).toSorted((a, b) => a - b)).toEqual([
            -1, 0, 24, 25, 100
        ]);
        expect(rows[0]).toHaveProperty('isp', null);
    });
});

describe('backfillDatacenterHostnames', () => {
    test('flags old clicks whose hostname is a datacenter', () => {
        const db = openDatabase(':memory:');
        db.run(
            "INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'a', 'https://a.com', 0, 0)"
        );
        const insert = db.query(
            "INSERT INTO clicks (link_id, ts, source, hostname) VALUES (1, 0, 'Direct', ?)"
        );
        insert.run('ec2-1-2-3-4.compute.amazonaws.com');
        insert.run('ec2-1-2-3-4.compute.amazonaws.com');
        insert.run('c-73-1-2-3.hsd1.ca.comcast.net');
        insert.run(null);

        expect(backfillDatacenterHostnames(db)).toBe(2);
        expect(
            db
                .query<{ dc: number }, []>('SELECT is_datacenter AS dc FROM clicks ORDER BY id')
                .all()
                .map(r => r.dc)
        ).toEqual([1, 1, 0, 0]);
        expect(backfillDatacenterHostnames(db)).toBe(0);
    });
});
