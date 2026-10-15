import type { Database } from 'bun:sqlite';

import type { ClickSink, RawClick } from '../shared/types.ts';
import { type ClickRow, enrichClick, type EnrichOptions } from './enrich.ts';

const COLUMNS = [
    'link_id',
    'ts',
    'country',
    'region',
    'city',
    'referrer_host',
    'referrer',
    'source',
    'via_qr',
    'device',
    'browser',
    'os',
    'is_bot',
    'visitor_hash',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'query'
] as const satisfies readonly (keyof ClickRow)[];

export interface ClickBufferOptions extends EnrichOptions {
    intervalMs?: number;
    /** Clicks held in memory before new ones are dropped (if SQLite is stuck). */
    maxBuffered?: number;
}

/**
 * Collects raw clicks in memory and writes them in one transaction per tick.
 * `push()` is the only thing the redirect path calls: an array push, nothing else.
 */
export class ClickBuffer implements ClickSink {
    #pending: RawClick[] = [];
    #timer: ReturnType<typeof setInterval> | null = null;
    #dropped = 0;
    #written = 0;
    readonly #db: Database;
    readonly #opts: Required<ClickBufferOptions>;
    readonly #insert;

    constructor(db: Database, opts: ClickBufferOptions) {
        this.#db = db;
        this.#opts = { intervalMs: 1000, maxBuffered: 100_000, ...opts };
        this.#insert = db.query(
            `INSERT INTO clicks (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`
        );
    }

    push(click: RawClick): void {
        if (this.#pending.length >= this.#opts.maxBuffered) {
            this.#dropped++;
            return;
        }
        this.#pending.push(click);
    }

    start(): void {
        if (this.#timer) return;
        this.#timer = setInterval(() => this.flush(), this.#opts.intervalMs);
    }

    /** Writes everything pending. Returns the number of rows written. */
    flush(): number {
        if (this.#pending.length === 0) return 0;
        const batch = this.#pending;
        this.#pending = [];
        try {
            this.#db.transaction((clicks: RawClick[]) => {
                for (const click of clicks) {
                    const row = enrichClick(click, this.#opts);
                    this.#insert.run(...COLUMNS.map(column => row[column]));
                }
            })(batch);
            this.#written += batch.length;
            return batch.length;
        } catch (error) {
            console.error('[clicks] flush failed, will retry', error);
            const room = this.#opts.maxBuffered - this.#pending.length;
            this.#dropped += Math.max(0, batch.length - room);
            this.#pending = [...batch.slice(0, room), ...this.#pending];
            return 0;
        }
    }

    stop(): void {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        this.flush();
    }

    get stats() {
        return { pending: this.#pending.length, written: this.#written, dropped: this.#dropped };
    }
}
