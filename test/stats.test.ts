import { beforeAll, describe, expect, test } from 'bun:test';

import { BadQueryError, filterCondition, Stats } from '../src/analytics/stats.ts';
import { openDatabase } from '../src/db/client.ts';
import type { StatsQuery } from '../src/shared/types.ts';

const T0 = Date.UTC(2026, 9, 10);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const db = openDatabase(':memory:');
const stats = new Stats(db);

beforeAll(() => {
    db.run(
        "INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'a', 'https://a.com', 0, 0), (2, 'b', 'https://b.com', 0, 0)"
    );
    const insert = db.query(
        `INSERT INTO clicks (link_id, ts, country, city, referrer_host, source, via_qr, os, browser, device, is_bot, visitor_hash, utm_campaign, query)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // link 1: three human clicks from two visitors on day 0, one QR click on day 1, one bot
    insert.run(
        1,
        T0 + HOUR,
        'CA',
        'Toronto',
        't.co',
        'X',
        0,
        'iOS',
        'Safari',
        'mobile',
        0,
        'v1',
        'launch',
        '{"ref":"ig"}'
    );
    insert.run(
        1,
        T0 + 2 * HOUR,
        'CA',
        'Toronto',
        't.co',
        'X',
        0,
        'iOS',
        'Safari',
        'mobile',
        0,
        'v1',
        null,
        '{"ref":"tw","v":"2"}'
    );
    insert.run(
        1,
        T0 + 3 * HOUR,
        'US',
        null,
        null,
        'Direct',
        0,
        'Windows',
        'Chrome',
        'desktop',
        0,
        'v2',
        null,
        null
    );
    insert.run(
        1,
        T0 + DAY + HOUR,
        'CA',
        'Ottawa',
        null,
        'QR',
        1,
        'Android',
        'Chrome',
        'mobile',
        0,
        'v3',
        null,
        null
    );
    insert.run(1, T0 + HOUR, 'US', null, null, 'Direct', 0, null, null, null, 1, 'bot', null, null);
    // link 2: one click, previous period
    insert.run(
        2,
        T0 - DAY + HOUR,
        'DE',
        'Berlin',
        'reddit.com',
        'Reddit',
        0,
        'macOS',
        'Firefox',
        'desktop',
        0,
        'v4',
        null,
        null
    );
});

const q = (overrides: Partial<StatsQuery> = {}): StatsQuery => ({
    from: T0,
    to: T0 + 2 * DAY,
    tz: 0,
    filters: [],
    ...overrides
});

describe('summary', () => {
    test('totals, uniques and previous period; bots excluded by default', () => {
        expect(stats.summary(q())).toEqual({
            clicks: 4,
            visitors: 3,
            previous: { clicks: 1, visitors: 1 }
        });
        expect(stats.summary(q({ bots: true })).clicks).toBe(5);
        expect(stats.summary(q({ link: 2 })).clicks).toBe(0);
    });
});

describe('timeseries', () => {
    test('daily buckets with gaps filled', () => {
        const res = stats.timeseries(q({ to: T0 + 5 * DAY }));
        expect(res.interval).toBe('day');
        expect(res.points.map(p => p.clicks)).toEqual([3, 1, 0, 0, 0]);
        expect(res.points[0]).toEqual({ t: T0, clicks: 3, visitors: 2 });
    });

    test('hourly for short ranges, shifted by timezone', () => {
        const res = stats.timeseries(q({ to: T0 + DAY }));
        expect(res.interval).toBe('hour');
        expect(res.points).toHaveLength(24);
        expect(res.points.slice(0, 4).map(p => p.clicks)).toEqual([0, 1, 1, 1]);

        const toronto = stats.timeseries(q({ to: T0 + 6 * DAY, tz: -240 }));
        expect(toronto.points[0]?.t).toBe(T0 - DAY + 4 * HOUR);
    });
});

describe('top', () => {
    test('column dimensions', () => {
        expect(stats.top(q(), 'country').rows).toEqual([
            { value: 'CA', label: 'CA', clicks: 3, visitors: 2 },
            { value: 'US', label: 'US', clicks: 1, visitors: 1 }
        ]);
        expect(stats.top(q(), 'referrer').rows).toContainEqual({
            value: null,
            label: 'Direct / none',
            clicks: 2,
            visitors: 2
        });
        expect(stats.top(q(), 'source').rows.map(r => r.value)).toEqual(['X', 'Direct', 'QR']);
    });

    test('links, QR split and query params', () => {
        expect(stats.top(q({ from: T0 - DAY }), 'link').rows.map(r => r.label)).toEqual(['a', 'b']);
        expect(stats.top(q(), 'qr').rows).toEqual([
            { value: 'Link', label: 'Link', clicks: 3, visitors: 2 },
            { value: 'QR', label: 'QR', clicks: 1, visitors: 1 }
        ]);
        expect(stats.top(q(), 'param').rows.map(r => [r.value, r.clicks])).toEqual([
            ['ref', 2],
            ['v', 1]
        ]);
        expect(stats.top(q(), 'param:ref').rows.map(r => r.value)).toEqual(['ig', 'tw']);
    });

    test('unknown dimensions are rejected', () => {
        expect(() => stats.top(q(), 'nope')).toThrow(BadQueryError);
        expect(() => stats.top(q(), 'param:bad"key')).toThrow(BadQueryError);
    });
});

describe('filters', () => {
    test('narrow every query; same-dimension filters are OR-ed', () => {
        expect(stats.summary(q({ filters: ['country:CA'] })).clicks).toBe(3);
        expect(stats.summary(q({ filters: ['country:CA', 'source:QR'] })).clicks).toBe(1);
        expect(stats.summary(q({ filters: ['country:CA', 'country:US'] })).clicks).toBe(4);
        expect(stats.summary(q({ filters: ['city:'] })).clicks).toBe(1);
        expect(stats.summary(q({ filters: ['qr:QR'] })).clicks).toBe(1);
        expect(stats.summary(q({ filters: ['param:ref=ig'] })).clicks).toBe(1);
        expect(stats.summary(q({ filters: ['param:v'] })).clicks).toBe(1);
        expect(stats.summary(q({ filters: ['link:1'] })).clicks).toBe(4);
        expect(stats.top(q({ filters: ['os:iOS'] }), 'utm_campaign').rows[0]?.value).toBe('launch');
    });

    test('invalid filters throw', () => {
        expect(() => filterCondition('nocolon')).toThrow(BadQueryError);
        expect(() => filterCondition('evil:x')).toThrow(BadQueryError);
        expect(() => filterCondition('link:abc')).toThrow(BadQueryError);
    });
});

describe('csv', () => {
    test('header, rows newest first, quoting', () => {
        const lines = stats.csv(q()).trim().split('\n');
        expect(lines[0]).toStartWith('time,slug,country');
        expect(lines).toHaveLength(5);
        expect(lines[1]).toStartWith(new Date(T0 + DAY + HOUR).toISOString());
        expect(lines.some(l => l.includes('"{""ref"":""ig""}"'))).toBe(true);
    });
});

describe('datacenter and fingerprint', () => {
    const db2 = openDatabase(':memory:');
    const stats2 = new Stats(db2);
    const T = Date.UTC(2026, 0, 1);

    beforeAll(() => {
        db2.run(
            "INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'a', 'https://a.com', 0, 0)"
        );
        const ins = db2.query(
            `INSERT INTO clicks (link_id, ts, source, via_qr, is_bot, is_datacenter, fingerprint, visitor_hash, country)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        // Two clicks from one device, one from another, one from a datacenter IP.
        ins.run(1, T + HOUR, 'Direct', 0, 0, 0, 'fp1', 'v1', 'CA');
        ins.run(1, T + 2 * HOUR, 'Direct', 0, 0, 0, 'fp1', 'v2', 'CA');
        ins.run(1, T + 3 * HOUR, 'Direct', 0, 0, 0, 'fp2', 'v3', 'US');
        ins.run(1, T + 4 * HOUR, 'Direct', 0, 0, 1, null, 'v4', 'US');
    });

    const qq = (overrides: Partial<StatsQuery> = {}): StatsQuery => ({
        from: T,
        to: T + DAY,
        tz: 0,
        filters: [],
        ...overrides
    });

    test('datacenter clicks are hidden unless dc is set', () => {
        expect(stats2.summary(qq()).clicks).toBe(3);
        expect(stats2.summary(qq({ dc: true })).clicks).toBe(4);
    });

    test('fingerprint is a group-by and filter dimension', () => {
        expect(stats2.top(qq(), 'fingerprint').rows.find(r => r.value === 'fp1')?.clicks).toBe(2);
        expect(stats2.summary(qq({ filters: ['fingerprint:fp1'] })).clicks).toBe(2);
    });

    test('history carries the datacenter flag and fingerprint', () => {
        const rows = stats2.history(qq({ dc: true })).clicks;
        expect(rows.filter(c => c.isDatacenter)).toHaveLength(1);
        expect(rows.find(c => c.fingerprint === 'fp1')?.isDatacenter).toBe(false);
    });
});
