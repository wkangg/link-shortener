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
    });
});
