import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { databaseInfo, MIGRATIONS_DIR, openDatabase, pingDatabase } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { createLinkLookup } from '../src/redirect/lookup.ts';

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

    test('databaseInfo reads the file path, WAL size and counts', () => {
        const file = path.join(tmp, 'info.db');
        const db = openDatabase(file);
        db.run(
            "INSERT INTO links (slug, url, created_at, updated_at) VALUES ('a', 'https://a.example', 0, 0)"
        );
        db.run('INSERT INTO clicks (link_id, ts) VALUES (1, 1234)');
        const info = databaseInfo(db);
        expect(info).toMatchObject({ path: file, links: 1, clicks: 1, firstClickAt: 1234 });
        expect(info.walBytes).toBeGreaterThan(0);
        expect(info.sizeBytes % 4096).toBe(0);
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
        // Slugs are unique regardless of case.
        expect(() => insert.run('ABC', 'https://example.org', 301)).toThrow(
            /UNIQUE constraint failed: links\.slug/
        );
        db.close();
    });

    test('slug lookups ignore case and use the NOCASE index', () => {
        const db = openDatabase(':memory:');
        db.run(
            "INSERT INTO links (slug, url, created_at, updated_at) VALUES ('GitHub', 'https://github.com', 0, 0)"
        );
        const lookup = createLinkLookup(db);
        expect(lookup('github')?.url).toBe('https://github.com');
        expect(lookup('GITHUB')?.url).toBe('https://github.com');
        const plan = db
            .query<{ detail: string }, []>(
                "EXPLAIN QUERY PLAN SELECT id FROM links WHERE slug = 'x' COLLATE NOCASE AND archived = 0"
            )
            .all()
            .map(r => r.detail)
            .join('\n');
        expect(plan).toContain('links_slug_nocase');
        db.close();
    });

    test('pingDatabase is false once closed', () => {
        const db = openDatabase(':memory:');
        db.close();
        expect(pingDatabase(db)).toBe(false);
    });
});
