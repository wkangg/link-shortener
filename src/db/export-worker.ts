// Runs VACUUM INTO on its own read-only connection, off the server's thread.
// With WAL the read sees a consistent snapshot and never blocks writers.
import { Database } from 'bun:sqlite';

declare const self: Worker;

export type ExportRequest = { source: string; target: string };
export type ExportResult = { ok: true } | { ok: false; error: string };

self.addEventListener('message', (event: MessageEvent<ExportRequest>) => {
    const { source, target } = event.data;
    let result: ExportResult = { ok: true };
    try {
        const db = new Database(source, { readonly: true });
        try {
            db.query('VACUUM INTO ?').run(target);
        } finally {
            db.close();
        }
    } catch (error) {
        result = { ok: false, error: String(error) };
    }
    self.postMessage(result);
});
