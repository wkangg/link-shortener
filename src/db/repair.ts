import type { Database } from 'bun:sqlite';

import { refineApple } from '../analytics/apple.ts';
import { visitorHash } from '../analytics/enrich.ts';
import { parseUserAgent } from '../analytics/ua.ts';
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

const APPLE_NAME = 'data:apple-device-details';

/**
 * One-time backfill of iOS version and iPhone/iPad model (analytics/apple.ts)
 * for clicks stored before they were recorded, including iPads that claimed to
 * be a Mac. Only Apple rows are read.
 */
export function backfillAppleDetails(db: Database): number {
    const done = db
        .query<{ name: string }, [string]>('SELECT name FROM _migrations WHERE name = ?')
        .get(APPLE_NAME);
    if (done) return 0;

    const rows = db
        .query<
            {
                id: number;
                ua: string | null;
                os: string | null;
                model: string | null;
                screen: string | null;
                touchPoints: number | null;
            },
            []
        >(
            `SELECT id, user_agent AS ua, os, device_model AS model, screen,
                    touch_points AS touchPoints
             FROM clicks WHERE os = 'iOS' OR (os = 'macOS' AND touch_points > 1)`
        )
        .all();
    const update = db.query(
        'UPDATE clicks SET os = ?, os_version = ?, device = ?, device_model = ? WHERE id = ?'
    );
    let fixed = 0;
    db.transaction(() => {
        for (const row of rows) {
            const model = row.ua ? (parseUserAgent(row.ua).model ?? row.model) : row.model;
            const apple = refineApple({ ...row, model }, row);
            if (!apple) continue;
            update.run(apple.os, apple.osVersion, apple.device, apple.model, row.id);
            fixed++;
        }
        db.query('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
            APPLE_NAME,
            Date.now()
        );
    })();
    return fixed;
}

const VISITOR_NAME = 'data:visitor-hash-without-day';

/**
 * One-time rehash of clicks stored when the visitor hash included the date, so a
 * visitor counts once across days. Clicks recorded before IPs were stored keep
 * their old per-day hash.
 */
export function rehashVisitors(db: Database, salt: string): number {
    const done = db
        .query<{ name: string }, [string]>('SELECT name FROM _migrations WHERE name = ?')
        .get(VISITOR_NAME);
    if (done) return 0;

    const rows = db
        .query<{ id: number; ip: string; ua: string | null }, []>(
            'SELECT id, ip, user_agent AS ua FROM clicks WHERE ip IS NOT NULL'
        )
        .all();
    const update = db.query('UPDATE clicks SET visitor_hash = ? WHERE id = ?');
    db.transaction(() => {
        for (const row of rows) update.run(visitorHash(row.ip, row.ua, salt), row.id);
        db.query('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
            VISITOR_NAME,
            Date.now()
        );
    })();
    return rows.length;
}
