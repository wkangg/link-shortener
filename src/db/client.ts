import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

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

export function pingDatabase(db: Database): boolean {
    try {
        return db.query<{ ok: number }, []>('SELECT 1 AS ok').get()?.ok === 1;
    } catch {
        return false;
    }
}
