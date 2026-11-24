// Answers the dashboard's stats queries on its own read-only connection, off the
// server's thread: SQLite calls block the thread they run on, and that thread also
// serves redirects. With WAL the reads never block the click writer.
import { Database } from 'bun:sqlite';

import { tuneReads } from '../db/client.ts';
import { BadQueryError, Stats } from './stats.ts';

declare const self: Worker;

export type StatsMethod = 'summary' | 'timeseries' | 'top' | 'suggest' | 'history';
export type StatsInit = { file: string; abuseMinScore: number };
export type StatsRequest = { id: number; method: StatsMethod; args: unknown[] };
/** A query's answer, or `stopped` once the connection is closed. */
export type StatsReply =
    | 'stopped'
    | { id: number; ok: true; value: unknown }
    | { id: number; ok: false; message: string; badQuery: boolean };

let db: Database | null = null;
let stats: Stats | null = null;

self.addEventListener('message', (event: MessageEvent<StatsInit | StatsRequest | 'stop'>) => {
    const data = event.data;
    if (data === 'stop') {
        db?.close();
        db = stats = null;
        self.postMessage('stopped');
        return;
    }
    if (!('id' in data)) {
        db = new Database(data.file, { readonly: true, strict: true });
        tuneReads(db);
        stats = new Stats(db, { abuseMinScore: data.abuseMinScore });
        return;
    }
    let reply: StatsReply;
    try {
        if (!stats) throw new Error('The stats worker has no database');
        const method = stats[data.method] as (...args: unknown[]) => unknown;
        reply = { id: data.id, ok: true, value: method.apply(stats, data.args) };
    } catch (error) {
        reply = {
            id: data.id,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            badQuery: error instanceof BadQueryError
        };
    }
    self.postMessage(reply);
});
