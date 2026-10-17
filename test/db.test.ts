import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { visitorHash } from '../src/analytics/enrich.ts';
import { MIGRATIONS_DIR, openDatabase, pingDatabase } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { rehashVisitors, repairGeoEncoding } from '../src/db/repair.ts';

const tmp = mkdtempSync(path.join(tmpdir(), 'shortener-db-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('database', () => {
    test('creates the file, enables WAL and applies migrations', () => {
        const db = openDatabase(path.join(tmp, 'nested', 'links.db'));
        expect(
            db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode
        ).toBe('wal');
        const tables = db
            .query<{ name: string }, []>(
                "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
            )
            .all()
            .map(r => r.name);
        expect(tables).toEqual(expect.arrayContaining(['_migrations', 'clicks', 'links']));
        expect(pingDatabase(db)).toBe(true);
        db.close();
    });

    test('repairs city/region stored as UTF-8 read as Latin-1, once', () => {
        const db = openDatabase(':memory:');
        db.run("DELETE FROM _migrations WHERE name LIKE 'data:%'");
        db.run(
            "INSERT INTO clicks (link_id, ts, city, region) VALUES (1, 0, 'MontrÃ©al', 'QuÃ©bec'), (1, 0, 'Zürich', NULL), (1, 0, 'Toronto', 'Ontario')"
        );
        expect(repairGeoEncoding(db)).toBe(1);
        const cities = db
            .query<{ city: string; region: string | null }, []>(
                'SELECT city, region FROM clicks ORDER BY id'
            )
            .all();
        expect(cities).toEqual([
            { city: 'Montréal', region: 'Québec' },
            { city: 'Zürich', region: null },
            { city: 'Toronto', region: 'Ontario' }
        ]);
        db.run("UPDATE clicks SET city = 'MontrÃ©al' WHERE id = 1");
        expect(repairGeoEncoding(db)).toBe(0); // already ran
        db.close();
    });

    test('rehashes visitors without the day, once', () => {
        const db = openDatabase(':memory:');
        db.run(
            `INSERT INTO clicks (link_id, ts, ip, user_agent, visitor_hash) VALUES
             (1, 0, '192.0.2.1', 'Firefox', 'monday'),
             (1, 86400000, '192.0.2.1', 'Firefox', 'tuesday'),
             (1, 0, NULL, NULL, 'no-ip')`
        );
        expect(rehashVisitors(db, 'salt')).toBe(2);
        const hashes = db
            .query<{ h: string | null }, []>('SELECT visitor_hash AS h FROM clicks ORDER BY id')
            .all()
            .map(r => r.h);
        expect(hashes).toEqual([
            visitorHash('192.0.2.1', 'Firefox', 'salt'),
            visitorHash('192.0.2.1', 'Firefox', 'salt'),
            'no-ip'
        ]);
        expect(rehashVisitors(db, 'salt')).toBe(0); // already ran
        db.close();
    });

    test('migrations are idempotent', () => {
        const db = openDatabase(':memory:');
        expect(migrate(db, MIGRATIONS_DIR)).toEqual([]);
        db.close();
    });

    test('schema enforces slug uniqueness and redirect types', () => {
        const db = openDatabase(':memory:');
        const insert = db.query(
            'INSERT INTO links (slug, url, redirect_type, created_at, updated_at) VALUES (?, ?, ?, 0, 0)'
        );
        insert.run('abc', 'https://example.com', 302);
        expect(() => insert.run('abc', 'https://example.org', 302)).toThrow();
        expect(() => insert.run('xyz', 'https://example.org', 200)).toThrow();
        // Slugs are case-sensitive.
        expect(() => insert.run('ABC', 'https://example.org', 301)).not.toThrow();
        db.close();
    });

    test('pingDatabase is false once closed', () => {
        const db = openDatabase(':memory:');
        db.close();
        expect(pingDatabase(db)).toBe(false);
    });
});
