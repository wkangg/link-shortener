import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { StatsReader } from '../src/analytics/stats-reader.ts';
import { BadQueryError, Stats } from '../src/analytics/stats.ts';
import { openDatabase } from '../src/db/client.ts';
import type { StatsQuery } from '../src/shared/types.ts';

const tmp = mkdtempSync(path.join(tmpdir(), 'shortener-stats-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const q = (extra: Partial<StatsQuery> = {}): StatsQuery => ({
    from: 0,
    to: 10_000,
    tz: 0,
    filters: [],
    ...extra
});

function database(name: string) {
    const db = openDatabase(path.join(tmp, name));
    db.run(
        "INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'a', 'https://a.com', 0, 0)"
    );
    const click = db.query(
        'INSERT INTO clicks (link_id, ts, country, browser, visitor_hash) VALUES (1, ?, ?, ?, ?)'
    );
    return { db, click };
}

describe('StatsReader', () => {
    test('answers from a worker what Stats answers here, and sees later writes', async () => {
        const { db, click } = database('worker.db');
        click.run(1000, 'CA', 'Firefox', 'v1');
        click.run(2000, 'US', 'Safari', 'v2');
        const reader = new StatsReader(db, { abuseMinScore: 25 });
        const local = new Stats(db);
        try {
            expect(await reader.summary(q())).toEqual(local.summary(q()));
            expect(await reader.top(q(), 'country', 10)).toEqual(local.top(q(), 'country', 10));
            expect(await reader.history(q({ q: 'firefox' }))).toEqual(
                local.history(q({ q: 'firefox' }))
            );

            // The worker's own connection reads what the server wrote after it opened.
            click.run(3000, 'CA', 'Chrome', 'v3');
            expect(await reader.summary(q())).toMatchObject({ clicks: 3 });
        } finally {
            await reader.stop();
            db.close();
        }
    });

    test('a bad search is still a BadQueryError (a 400), and the queries beside it still answer', async () => {
        const { db, click } = database('errors.db');
        click.run(1000, 'CA', 'Firefox', 'v1');
        const reader = new StatsReader(db, { abuseMinScore: 25 });
        try {
            const [bad, good] = await Promise.allSettled([
                reader.summary(q({ q: 'is:nope' })),
                reader.timeseries(q())
            ]);
            expect(bad.status === 'rejected' && bad.reason).toBeInstanceOf(BadQueryError);
            expect(good.status === 'fulfilled' && good.value.points).not.toHaveLength(0);
        } finally {
            await reader.stop();
            db.close();
        }
    });

    test('stopping answers the queries already asked, then lets go of the file', async () => {
        const { db, click } = database('stop.db');
        click.run(1000, 'CA', 'Firefox', 'v1');
        const reader = new StatsReader(db, { abuseMinScore: 25 });
        const asked = reader.summary(q());
        await reader.stop();
        expect(await asked).toMatchObject({ clicks: 1 });
        // A query after that is refused rather than starting a worker nothing would stop.
        await expect(reader.summary(q())).rejects.toThrow('shut down');
        db.close();
        // Windows refuses to delete a file that's still open.
        rmSync(path.join(tmp, 'stop.db'));
    });

    test('an in-memory database is queried in this thread', async () => {
        const db = openDatabase(':memory:');
        const reader = new StatsReader(db, { abuseMinScore: 25 });
        expect(await reader.summary(q())).toEqual({ clicks: 0, visitors: 0, previous: null });
        await expect(reader.summary(q({ q: 'is:nope' }))).rejects.toBeInstanceOf(BadQueryError);
        await reader.stop();
        await expect(reader.summary(q())).rejects.toThrow('shut down');
    });
});

describe('StatsReader pool', () => {
    const script = new URL('fixtures/stats-worker.ts', import.meta.url);
    const SLOW_MS = 300; // what the fixture holds a `slow!` query for

    test('answers queries side by side, one worker each, up to its size', async () => {
        const { db, click } = database('pool.db');
        click.run(1000, 'CA', 'Firefox', 'v1');
        const reader = new StatsReader(db, { abuseMinScore: 25, workers: 2, script });
        try {
            // Workers start only once there's something to ask.
            expect(reader.workers).toBe(0);
            const started = performance.now();
            const slow = [reader.summary(q({ q: 'slow!' })), reader.summary(q({ q: 'slow!' }))];
            // A third waits its turn rather than starting a worker past the limit.
            const third = reader.top(q(), 'country', 10);
            expect(reader.workers).toBe(2);
            await Promise.all(slow);
            // Two 300 ms queries, side by side.
            expect(performance.now() - started).toBeLessThan(2 * SLOW_MS);
            const { rows } = await third;
            expect(rows).toHaveLength(1);
        } finally {
            await reader.stop();
            db.close();
        }
    });

    test('a worker that dies fails only its query, and another takes its place', async () => {
        const { db, click } = database('crash.db');
        click.run(1000, 'CA', 'Firefox', 'v1');
        const reader = new StatsReader(db, { abuseMinScore: 25, workers: 1, script });
        try {
            const crashed = reader.summary(q({ q: 'crash!' }));
            const queued = reader.summary(q());
            await expect(crashed).rejects.toThrow('Stats worker');
            expect(await queued).toMatchObject({ clicks: 1 });
            expect(await reader.summary(q())).toMatchObject({ clicks: 1 });
            expect(reader.workers).toBe(1);
        } finally {
            await reader.stop();
            db.close();
        }
    });

    test('a waiting query whose request went away is dropped, not run', async () => {
        const { db, click } = database('abort.db');
        click.run(1000, 'CA', 'Firefox', 'v1');
        const reader = new StatsReader(db, { abuseMinScore: 25, workers: 1, script });
        try {
            const started = performance.now();
            const first = reader.summary(q({ q: 'slow!' }));
            const gone = new AbortController();
            const dropped = reader.for(gone.signal).summary(q({ q: 'slow!' }));
            const next = reader.summary(q());
            gone.abort();
            await expect(dropped).rejects.toThrow(/abort/i);
            await first;
            expect(await next).toMatchObject({ clicks: 1 });
            // The dropped query never held the worker.
            expect(performance.now() - started).toBeLessThan(2 * SLOW_MS);

            // A query whose request is still there runs as usual.
            const kept = new AbortController();
            expect(await reader.for(kept.signal).summary(q())).toMatchObject({ clicks: 1 });
        } finally {
            await reader.stop();
            db.close();
        }
    });

    test('a worker with nothing to do stops, and a new one starts when asked', async () => {
        const { db, click } = database('idle.db');
        click.run(1000, 'CA', 'Firefox', 'v1');
        const reader = new StatsReader(db, { abuseMinScore: 25, idleMs: 20 });
        try {
            await reader.summary(q());
            expect(reader.workers).toBe(1);
            await Bun.sleep(200);
            expect(reader.workers).toBe(0);
            expect(await reader.summary(q())).toMatchObject({ clicks: 1 });
        } finally {
            await reader.stop();
            db.close();
        }
    });

    test('stopping answers every query asked, queued ones too, then closes each connection', async () => {
        const { db, click } = database('stop-pool.db');
        click.run(1000, 'CA', 'Firefox', 'v1');
        const reader = new StatsReader(db, { abuseMinScore: 25, workers: 2, script });
        const asked = [
            reader.summary(q({ q: 'slow!' })),
            reader.summary(q({ q: 'slow!' })),
            reader.summary(q())
        ];
        const stopped = reader.stop();
        await expect(reader.summary(q())).rejects.toThrow('shut down');
        await stopped;
        expect(reader.workers).toBe(0);
        for (const answer of await Promise.all(asked)) expect(answer).toMatchObject({ clicks: 1 });
        db.close();
        // Windows refuses to delete a file that's still open.
        rmSync(path.join(tmp, 'stop-pool.db'));
    });
});
