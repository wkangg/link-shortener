import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MIGRATIONS_DIR, openDatabase, pingDatabase } from '../src/db/client.ts';
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

    test('the case-insensitive migration renames newer links whose slugs differ only by case', () => {
        const dir = path.join(tmp, 'migrations-0001');
        mkdirSync(dir);
        copyFileSync(path.join(MIGRATIONS_DIR, '0001_init.sql'), path.join(dir, '0001_init.sql'));
        const db = new Database(':memory:', { strict: true });
        migrate(db, dir);
        const insert = db.query(
            'INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (?, ?, ?, 0, 0)'
        );
        insert.run(1, 'gh', 'https://a.com');
        insert.run(2, 'GH', 'https://b.com');
        insert.run(3, 'Gh', 'https://c.com');
        insert.run(4, 'other', 'https://d.com');
        insert.run(5, 'x'.repeat(64), 'https://e.com');
        insert.run(6, 'X'.repeat(64), 'https://f.com');

        expect(migrate(db, MIGRATIONS_DIR)).toContain('0002_case_insensitive_slugs.sql');
        const slugs = db
            .query<{ slug: string }, []>('SELECT slug FROM links ORDER BY id')
            .all()
            .map(r => r.slug);
        expect(slugs).toEqual([
            'gh',
            'GH-2',
            'Gh-3',
            'other',
            'x'.repeat(64),
            `${'X'.repeat(62)}-6`
        ]);
        db.close();
    });

    test('pingDatabase is false once closed', () => {
        const db = openDatabase(':memory:');
        db.close();
        expect(pingDatabase(db)).toBe(false);
    });
});
