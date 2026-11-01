import { Database } from 'bun:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { DatabaseInfo } from '../shared/types.ts';
import type { ExportRequest, ExportResult } from './export-worker.ts';
import { migrate } from './migrate.ts';

export const MIGRATIONS_DIR = path.join(import.meta.dir, 'migrations');

/**
 * Opens (creating if needed) the SQLite database, applies connection PRAGMAs,
 * and runs pending migrations. Pass ":memory:" for tests.
 */
export function openDatabase(file: string, opts: { log?: boolean } = {}): Database {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });

    const db = new Database(file, { create: true, strict: true });

    db.run('PRAGMA journal_mode = WAL'); // readers never block the writer
    db.run('PRAGMA synchronous = NORMAL'); // safe with WAL; far fewer fsyncs
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA temp_store = MEMORY');
    db.run('PRAGMA cache_size = -32000'); // ~32 MB page cache
    db.run('PRAGMA mmap_size = 268435456'); // 256 MB memory-mapped reads

    const applied = migrate(db, MIGRATIONS_DIR);
    if (opts.log && applied.length > 0)
        console.log(`[db] applied migrations: ${applied.join(', ')}`);

    return db;
}

/** Size, versions and row counts for the dashboard's About section. */
export function databaseInfo(db: Database): DatabaseInfo {
    // A SELECT with no FROM always returns exactly one row.
    const row = db
        .query(
            `SELECT
                (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS sizeBytes,
                (SELECT freelist_count FROM pragma_freelist_count()) * (SELECT page_size FROM pragma_page_size()) AS freeBytes,
                sqlite_version() AS sqliteVersion,
                (SELECT MAX(name) FROM _migrations) AS migration,
                (SELECT COUNT(*) FROM links) AS links,
                (SELECT COUNT(*) FROM clicks) AS clicks,
                (SELECT COUNT(*) FROM webhook_endpoints) AS webhooks,
                (SELECT COUNT(*) FROM webhook_events) AS webhookEvents,
                (SELECT MIN(ts) FROM clicks) AS firstClickAt`
        )
        .get() as Omit<DatabaseInfo, 'path' | 'walBytes'>;
    const file = db.filename === ':memory:' ? '' : db.filename;
    const walBytes = file ? (statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0) : 0;
    return { path: file, walBytes, ...row };
}

/**
 * Writes a compact, standalone copy of the database to `target` with VACUUM
 * INTO. File databases are copied in a Worker so redirects aren't held up;
 * an in-memory one (tests) can't be opened from another thread, so it's
 * copied here.
 */
export function copyDatabase(db: Database, target: string): Promise<void> {
    if (db.filename === ':memory:' || db.filename === '') {
        db.query('VACUUM INTO ?').run(target);
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('export-worker.ts', import.meta.url));
        worker.addEventListener('message', (event: MessageEvent<ExportResult>) => {
            worker.terminate();
            if (event.data.ok) resolve();
            else reject(new Error(event.data.error));
        });
        worker.addEventListener('error', event => {
            worker.terminate();
            reject(new Error(event.message));
        });
        const request: ExportRequest = { source: db.filename, target };
        worker.postMessage(request);
    });
}

export function pingDatabase(db: Database): boolean {
    try {
        return db.query<{ ok: number }, []>('SELECT 1 AS ok').get()?.ok === 1;
    } catch {
        return false;
    }
}
