import { describe, expect, test } from 'bun:test';

import {
    classify,
    ClickClassifier,
    type ClickFacts,
    SIGNALS_WINDOW_MS
} from '../src/analytics/classify.ts';
import { ClickBuffer } from '../src/analytics/clicks.ts';
import { whereClause } from '../src/analytics/stats.ts';
import { RangeSet, VpnLists } from '../src/analytics/vpn.ts';
import { openDatabase } from '../src/db/client.ts';
import type { RawClick } from '../src/shared/types.ts';

const NOW = 1_700_000_000_000;
const CHROME =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function facts(over: Partial<ClickFacts> = {}): ClickFacts {
    return {
        ts: NOW,
        ip: '203.0.113.9',
        ua: CHROME,
        is_bot: 0,
        language: 'en-US',
        timezone: null,
        js: null,
        webdriver: null,
        gpu: null,
        hostname: null,
        isp: null,
        is_datacenter: 0,
        ...over
    };
}

const noLists = () => null;
const tor = (ip: string) => (ip === '203.0.113.9' ? 'Tor' : null);
const reason = (over: Partial<ClickFacts>) => classify(facts(over), noLists, NOW).scraper;

describe('RangeSet', () => {
    test('matches IPv4 and IPv6 CIDRs, bare addresses and mapped IPv4', () => {
        const set = RangeSet.fromCidrs([
            '172.224.226.0/27',
            '172.224.226.32/31',
            '171.25.193.25',
            '2a02:26f7:b3c0:4000::/64',
            'garbage',
            '1.2.3.4/40'
        ]);
        expect(set.has('172.224.226.0')).toBe(true);
        expect(set.has('172.224.226.33')).toBe(true);
        expect(set.has('172.224.226.34')).toBe(false);
        expect(set.has('171.25.193.25')).toBe(true);
        expect(set.has('171.25.193.26')).toBe(false);
        expect(set.has('2a02:26f7:b3c0:4000:1:2:3:4')).toBe(true);
        expect(set.has('2a02:26f7:b3c0:4001::1')).toBe(false);
        expect(set.has('::ffff:171.25.193.25')).toBe(true);
        expect(set.has('1.2.3.4')).toBe(false);
        expect(set.has('not an ip')).toBe(false);
        // Adjacent ranges merge: /27 + /31 is one range.
        expect(set.size).toBe(3);
    });

    test('survives a serialize round trip', () => {
        const set = RangeSet.fromCidrs(['10.0.0.0/8', '2001:db8::/32']);
        const back = RangeSet.deserialize(set.serialize());
        expect(back.has('10.255.0.1')).toBe(true);
        expect(back.has('2001:db8:ffff::1')).toBe(true);
        expect(back.has('11.0.0.0')).toBe(false);
    });
});

describe('VpnLists', () => {
    const TOR = '# exit list\n171.25.193.25\n80.67.167.81\n';
    const RELAY = '104.28.0.0/24,US,US-CA,Los Angeles,\n2a02:26f7::/32,GB,GB-EN,London,\n';

    test('downloads, labels and stores the lists; WARP is built in', async () => {
        const db = openDatabase(':memory:');
        const fetched: string[] = [];
        const lists = new VpnLists(db, {
            fetchText: url => {
                fetched.push(url);
                return Promise.resolve(url.includes('torproject') ? TOR : RELAY);
            },
            now: () => NOW
        });
        expect(lists.lookup('171.25.193.25')).toBeNull();
        expect(await lists.refresh()).toBe(true);
        expect(fetched).toHaveLength(2);
        expect(lists.lookup('171.25.193.25')).toBe('Tor');
        // Apple's ranges win over the WARP block they sit in.
        expect(lists.lookup('104.28.0.7')).toBe('iCloud Private Relay');
        expect(lists.lookup('104.28.1.7')).toBe('Cloudflare WARP');
        expect(lists.lookup('2a09:bac1::5')).toBe('Cloudflare WARP');
        expect(lists.lookup('8.8.8.8')).toBeNull();

        // Fresh lists aren't fetched again, and a restart reads them from the database.
        expect(await lists.refresh()).toBe(false);
        expect(fetched).toHaveLength(2);
        const again = new VpnLists(db, { fetchText: null });
        expect(again.lookup('80.67.167.81')).toBe('Tor');
    });

    test('a failed or empty download keeps the last good list', async () => {
        const db = openDatabase(':memory:');
        let now = NOW;
        let body: string | null = TOR;
        const lists = new VpnLists(db, {
            fetchText: () =>
                body === null ? Promise.reject(new Error('offline')) : Promise.resolve(body),
            now: () => now
        });
        await lists.refresh();
        now += 2 * 86_400_000;
        body = '';
        const error = console.error;
        console.error = () => {};
        try {
            await lists.refresh();
            body = null;
            await lists.refresh();
        } finally {
            console.error = error;
        }
        expect(lists.lookup('171.25.193.25')).toBe('Tor');
    });
});

describe('classify', () => {
    test('an ordinary browser on a home connection is neither', () => {
        expect(classify(facts(), noLists, NOW)).toEqual({ vpn: null, scraper: null });
        expect(classify(facts({ js: 1, timezone: 'UTC' }), noLists, NOW)).toEqual({
            vpn: null,
            scraper: null
        });
    });

    test('listed exits are VPNs, and declared bots are never scrapers', () => {
        expect(classify(facts({ js: 1, timezone: 'UTC' }), tor, NOW)).toEqual({
            vpn: 'Tor',
            scraper: null
        });
        expect(
            classify(facts({ ua: 'curl/8.0', is_bot: 1, language: null }), noLists, NOW)
        ).toEqual({ vpn: null, scraper: null });
    });

    test('flags headers and browsers that scripts give away', () => {
        expect(reason({ ua: null })).toBe('No user agent');
        expect(reason({ language: null })).toBe('No Accept-Language header');
        expect(reason({ js: 1, webdriver: 1 })).toBe('Automated browser (webdriver)');
        expect(reason({ js: 1, gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))' })).toBe(
            'Software renderer (headless browser)'
        );
    });

    test('splits hosting IPs into VPN users and scrapers by behaviour', () => {
        const dc = { is_datacenter: 1, hostname: 'x.compute.amazonaws.com' };
        const verdict = (over: Partial<ClickFacts>) =>
            classify(facts({ ...dc, ...over }), noLists, NOW);
        expect(verdict({ js: 1, timezone: 'America/Toronto' })).toEqual({
            vpn: 'Browser on a hosting IP',
            scraper: null
        });
        expect(verdict({ js: 1, timezone: 'Etc/UTC' })).toEqual({
            vpn: null,
            scraper: 'UTC clock on a hosting IP'
        });
        // The page was served but never ran: only a verdict once the window has passed.
        expect(verdict({ js: 0 })).toEqual({ vpn: null, scraper: null });
        expect(verdict({ js: 0, ts: NOW - SIGNALS_WINDOW_MS })).toEqual({
            vpn: null,
            scraper: 'Skipped JavaScript on a hosting IP'
        });
        // Plain redirect, no signals: undecided, stays a datacenter click.
        expect(verdict({})).toEqual({ vpn: null, scraper: null });
    });

    test('networks VPN services rent count as VPNs unless the click looks automated', () => {
        const m247 = { isp: 'M247 Europe SRL' };
        expect(classify(facts(m247), noLists, NOW)).toEqual({
            vpn: 'VPN host: M247',
            scraper: null
        });
        expect(classify(facts({ ...m247, language: null }), noLists, NOW).vpn).toBeNull();
    });
});

describe('ClickClassifier', () => {
    test('stores verdicts, and the stats query hides and shows them per toggle', () => {
        const db = openDatabase(':memory:');
        db.run(
            `INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'a', 'https://e.x', 0, 0)`
        );
        const insert = db.query(
            `INSERT INTO clicks (link_id, ts, source, ip, user_agent, language, timezone, js, is_datacenter)
             VALUES (1, ?, 'Direct', ?, ?, ?, ?, ?, ?)`
        );
        insert.run(NOW, '1.1.1.1', CHROME, 'en', null, null, 0); // person
        insert.run(NOW, '2.2.2.2', CHROME, null, null, null, 0); // scraper: no Accept-Language
        insert.run(NOW, '3.3.3.3', CHROME, 'en', 'Europe/Berlin', 1, 1); // VPN on a hosting IP
        insert.run(NOW, '4.4.4.4', CHROME, 'en', null, null, 1); // undecided datacenter
        insert.run(NOW, '5.5.5.5', CHROME, 'en', null, null, 0); // Tor

        const classifier = new ClickClassifier(db, {
            lookup: ip => (ip === '5.5.5.5' ? 'Tor' : null),
            now: () => NOW
        });
        expect(classifier.all()).toBe(3);
        expect(classifier.all()).toBe(0);

        const ips = (query: Record<string, unknown>) => {
            const where = whereClause({ from: 0, to: NOW + 1, tz: 0, filters: [], ...query });
            return db
                .query<{ ip: string }, (string | number)[]>(
                    `SELECT ip FROM clicks c WHERE ${where.sql} ORDER BY ip`
                )
                .all(...where.params)
                .map(r => r.ip);
        };
        expect(ips({})).toEqual(['1.1.1.1', '3.3.3.3', '5.5.5.5']);
        expect(ips({ vpn: false })).toEqual(['1.1.1.1']);
        expect(ips({ scrapers: true })).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3', '5.5.5.5']);
        expect(ips({ dc: true })).toEqual(['1.1.1.1', '3.3.3.3', '4.4.4.4', '5.5.5.5']);
        expect(ips({ q: 'is:scraper' })).toEqual(['2.2.2.2']);
        expect(ips({ q: 'vpn:tor' })).toEqual(['5.5.5.5']);
        expect(ips({ vpn: false, q: 'is:vpn' })).toEqual(['3.3.3.3', '5.5.5.5']);
    });
});

const tokenClick = (token: string, ts: number): RawClick => ({
    linkId: 1,
    ts,
    url: 'https://e.x',
    ip: token === 'old' ? '198.51.100.20' : '192.0.2.44',
    ua: CHROME,
    referrer: '',
    country: '',
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
    language: 'en-US',
    timezone: '',
    token,
    latitude: '',
    longitude: ''
});

describe('ClickBuffer classification', () => {
    test('classifies clicks as signals arrive and when the page never reports back', () => {
        const db = openDatabase(':memory:');
        db.run(
            `INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'a', 'https://e.x', 0, 0)`
        );
        const buffer = new ClickBuffer(db, { shortHost: 's.example', salt: 'salt' });
        const now = Date.now();
        for (const c of [
            tokenClick('old', now - SIGNALS_WINDOW_MS - 1000),
            tokenClick('bot', now)
        ]) {
            buffer.push(c);
        }
        buffer.flush();
        // The old click came from a hosting IP (normally set from its hostname).
        db.run("UPDATE clicks SET is_datacenter = 1 WHERE token = 'old'");

        buffer.pushSignals(
            'bot',
            JSON.stringify({ t: 'bot', screen: '800x600', webdriver: true }),
            now
        );
        buffer.flush();
        const rows = db
            .query<
                { ip: string; js: number | null; webdriver: number | null; scraper: string | null },
                []
            >('SELECT ip, js, webdriver, scraper FROM clicks ORDER BY id')
            .all();
        expect(rows).toEqual([
            {
                ip: '198.51.100.20',
                js: 0,
                webdriver: null,
                scraper: 'Skipped JavaScript on a hosting IP'
            },
            { ip: '192.0.2.44', js: 1, webdriver: 1, scraper: 'Automated browser (webdriver)' }
        ]);
    });
});
