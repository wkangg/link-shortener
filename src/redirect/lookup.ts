// HOT PATH. One prepared statement, compiled once.
import type { Database } from 'bun:sqlite';

import type { CachedLink } from './cache.ts';

interface Row {
    id: number;
    url: string;
    redirect_type: number;
    expires_at: number | null;
}

export type LinkLookup = (slug: string) => CachedLink | null;

export function createLinkLookup(db: Database): LinkLookup {
    const stmt = db.query<Row, [string]>(
        'SELECT id, url, redirect_type, expires_at FROM links WHERE slug = ? AND archived = 0'
    );
    return slug => {
        const row = stmt.get(slug);
        return row
            ? { id: row.id, url: row.url, status: row.redirect_type, expiresAt: row.expires_at }
            : null;
    };
}
