import { describe, expect, test } from 'bun:test';

import { Stats } from '../src/analytics/stats.ts';
import { LocalClock, zoneOffset } from '../src/analytics/timezone.ts';
import { LinkRepo } from '../src/dashboard/links.ts';
import { openDatabase } from '../src/db/client.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TORONTO = 'America/Toronto';
// Toronto leaves daylight saving at 2:00 EDT on 1 November 2026 (06:00 UTC).
const FALL_BACK = Date.UTC(2026, 10, 1, 6);

describe('LocalClock', () => {
    test('finds the minute a zone changes offset', () => {
        expect(zoneOffset(TORONTO, FALL_BACK - 1)).toBe(-240);
        expect(zoneOffset(TORONTO, FALL_BACK)).toBe(-300);
        expect(zoneOffset('Asia/Kathmandu', FALL_BACK)).toBe(345);

        const clock = new LocalClock(
            { zone: TORONTO },
            Date.UTC(2026, 9, 1),
            Date.UTC(2026, 11, 1)
        );
        expect(clock.offsetAt(FALL_BACK - 1)).toBe(-240);
        expect(clock.offsetAt(FALL_BACK)).toBe(-300);
        // Local midnight before and after the change.
        expect(clock.utc(Date.UTC(2026, 9, 21))).toBe(Date.UTC(2026, 9, 21, 4));
        expect(clock.utc(Date.UTC(2026, 10, 10))).toBe(Date.UTC(2026, 10, 10, 5));
    });

    test('without a zone, or one this server does not know, one offset throughout', () => {
        const one = { sql: '(c.ts + ?)', params: [-300 * 60_000] };
        expect(new LocalClock({ tz: -300 }, 0, DAY).sql('c.ts')).toEqual(one);
        expect(new LocalClock({ zone: 'Etc/Unknown', tz: -300 }, 0, DAY).sql('c.ts')).toEqual(one);
    });

    test('a local midnight the clocks repeat starts at the first one', () => {
        // Amman went from 00:59 back to 00:00 on 29 October 2021 (22:00 UTC), so that
        // midnight came twice: 21:00 and 22:00 UTC.
        const clock = new LocalClock(
            { zone: 'Asia/Amman' },
            Date.UTC(2021, 9, 20),
            Date.UTC(2021, 10, 5)
        );
        expect(clock.utc(Date.UTC(2021, 9, 29))).toBe(Date.UTC(2021, 9, 28, 21));
        expect(clock.utc(Date.UTC(2021, 9, 30))).toBe(Date.UTC(2021, 9, 29, 22));
    });

    test('a local midnight the clocks skip starts when they jump', () => {
        // Santiago goes from 23:59 on 5 September 2026 straight to 01:00 on the 6th.
        const jump = Date.UTC(2026, 8, 6, 4);
        const clock = new LocalClock(
            { zone: 'America/Santiago' },
            Date.UTC(2026, 7, 1),
            Date.UTC(2026, 9, 1)
        );
        expect(clock.utc(Date.UTC(2026, 8, 6))).toBe(jump);
        expect(clock.local(jump)).toBe(Date.UTC(2026, 8, 6, 1));
        expect(clock.utc(Date.UTC(2026, 8, 5))).toBe(Date.UTC(2026, 8, 5, 4));
    });
});

describe('local days across a daylight saving change', () => {
    // 00:30 EDT on 21 October and 00:30 EST on 10 November: just after midnight both times.
    const OCT_21 = Date.UTC(2026, 9, 21, 4, 30);
    const NOV_10 = Date.UTC(2026, 10, 10, 5, 30);

    function database() {
        const db = openDatabase(':memory:');
        db.run(
            "INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'a', 'https://a.com', 0, 0)"
        );
        const click = db.query('INSERT INTO clicks (link_id, ts, visitor_hash) VALUES (1, ?, ?)');
        click.run(OCT_21, 'v1');
        click.run(NOV_10, 'v2');
        return db;
    }

    test('the chart puts each click on its own local day', () => {
        const stats = new Stats(database());
        const from = Date.UTC(2026, 9, 15, 4);
        const to = Date.UTC(2026, 10, 15, 5);
        const days = (zone: { tz: number; zone?: string }) =>
            stats
                .timeseries({ from, to, filters: [], ...zone })
                .points.filter(p => p.clicks > 0)
                .map(p => p.t);

        expect(days({ tz: -300, zone: TORONTO })).toEqual([
            Date.UTC(2026, 9, 21, 4), // local midnight, 21 October (EDT)
            Date.UTC(2026, 10, 10, 5) // local midnight, 10 November (EST)
        ]);
        // November's offset alone moves the October click to the 20th.
        expect(days({ tz: -300 })[0]).toBe(Date.UTC(2026, 9, 20, 5));
    });

    test('the first day starts at its own midnight when the range opens after a change', () => {
        // Opens at 07:00 EST on 1 November, after the change; that day began at 00:00 EDT.
        const { points } = new Stats(database()).timeseries({
            from: Date.UTC(2026, 10, 1, 12),
            to: Date.UTC(2026, 10, 6, 5),
            filters: [],
            tz: -300,
            zone: TORONTO
        });
        expect(points[0]?.t).toBe(Date.UTC(2026, 10, 1, 4));
    });

    test('sparklines too', () => {
        // 3 November, noon in Toronto: the last 7 days are 28 October to 3 November.
        const now = Date.UTC(2026, 10, 3, 17);
        const db = database();
        db.query('UPDATE clicks SET ts = ? WHERE visitor_hash = ?').run(
            Date.UTC(2026, 9, 31, 4, 30), // 00:30 EDT, 31 October
            'v1'
        );
        const links = new LinkRepo(db, { invalidate() {} }, () => now);
        const spark = (opts: { tz: number; zone?: string }) => links.list(opts).links[0]?.spark;
        expect(spark({ tz: -300, zone: TORONTO })).toEqual([0, 0, 0, 1, 0, 0, 0]);
        expect(spark({ tz: -300 })).toEqual([0, 0, 1, 0, 0, 0, 0]);
    });
});
