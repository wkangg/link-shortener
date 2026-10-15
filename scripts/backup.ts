// Consistent online backup of the SQLite database, keeping the newest N copies.
// Usage: bun run backup   (DB_PATH, BACKUP_DIR default <db dir>/backups, BACKUP_KEEP default 14)
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { openDatabase } from '../src/db/client.ts';

const dbPath = process.env.DB_PATH ?? './data/links.db';
const dir = process.env.BACKUP_DIR ?? path.join(path.dirname(dbPath), 'backups');
const keep = Number(process.env.BACKUP_KEEP ?? 14) || 14;

const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const target = path.join(dir, `links-${stamp}.db`);

mkdirSync(dir, { recursive: true });
const db = openDatabase(dbPath);

// VACUUM INTO writes a compact, consistent copy without blocking redirects.
db.query('VACUUM INTO ?').run(target);
db.close();

const old = readdirSync(dir)
    .filter(f => /^links-.+\.db$/.test(f))
    .toSorted()
    .toReversed()
    .slice(keep);
for (const file of old) rmSync(path.join(dir, file));

console.log(`Backed up ${dbPath} to ${target}; removed ${old.length} old backup(s)`);
