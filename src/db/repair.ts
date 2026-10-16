import type { Database } from 'bun:sqlite';

import { fixUtf8ReadAsLatin1 } from '../shared/text.ts';

/** Recorded in `_migrations` so this runs once. Not a .sql file, so the migrator ignores it. */
const NAME = 'data:fix-geo-header-encoding';

/**
 * One-time repair for city/region values stored before header decoding was fixed
 * (UTF-8 read as Latin-1, e.g. "MontrÃ©al"). Only rows with non-ASCII text are read.
 */
export function repairGeoEncoding(db: Database): number {
    const done = db
        .query<{ name: string }, [string]>('SELECT name FROM _migrations WHERE name = ?')
        .get(NAME);
    if (done) return 0;

    const rows = db
        .query<{ id: number; region: string | null; city: string | null }, []>(
            `SELECT id, region, city FROM clicks
             WHERE city GLOB '*[^ -~]*' OR region GLOB '*[^ -~]*'`
        )
        .all();
    const update = db.query('UPDATE clicks SET region = ?, city = ? WHERE id = ?');
    let fixed = 0;
    db.transaction(() => {
        for (const row of rows) {
            const region = row.region === null ? null : fixUtf8ReadAsLatin1(row.region);
            const city = row.city === null ? null : fixUtf8ReadAsLatin1(row.city);
            if (region === row.region && city === row.city) continue;
            update.run(region, city, row.id);
            fixed++;
        }
        db.query('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(NAME, Date.now());
    })();
    return fixed;
}
