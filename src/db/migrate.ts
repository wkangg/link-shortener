import type { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal forward-only migrator.
 *
 * Applies every `NNNN_name.sql` file in `dir` that isn't recorded in `_migrations`,
 * in filename order, each inside its own transaction. Migration files are never
 * edited after they've shipped; add a new file instead.
 */
export function migrate(db: Database, dir: string): string[] {
    db.run(`CREATE TABLE IF NOT EXISTS _migrations (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  ) STRICT`);

    const applied = new Set(
        db
            .query<{ name: string }, []>('SELECT name FROM _migrations')
            .all()
            .map(r => r.name)
    );

    const pending = readdirSync(dir)
        .filter(f => /^\d{4}_[\w-]+\.sql$/.test(f))
        .toSorted()
        .filter(f => !applied.has(f));

    const record = db.query('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');

    for (const file of pending) {
        const sql = readFileSync(path.join(dir, file), 'utf8');
        db.transaction(() => {
            db.run(sql);
            record.run(file, Date.now());
        })();
    }

    return pending;
}
