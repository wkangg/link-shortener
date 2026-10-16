import type { Database } from 'bun:sqlite';

import type { ClickSink, RawClick } from '../shared/types.ts';
import {
    type ClickRow,
    type DeviceSignals,
    enrichClick,
    type EnrichOptions,
    parseSignals
} from './enrich.ts';

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
    'query',
    'ip',
    'user_agent',
    'language',
    'timezone',
    'bot_name',
    'device_model',
    'token',
    'latitude',
    'longitude'
] as const satisfies readonly (keyof ClickRow)[];

const SIGNAL_COLUMNS = [
    'screen',
    'orientation',
    'battery',
    'charging',
    'connection',
    'gpu',
    'incognito',
    'ad_blocker',
    'memory',
    'platform',
    'touch_points'
] as const satisfies readonly (keyof DeviceSignals)[];

/** Signals must arrive within this long of the click; unused tokens are cleared after it. */
const SIGNALS_WINDOW_MS = 10 * 60_000;
/** Reverse DNS lookups in flight at once; clicks beyond it just get no hostname. */
const MAX_LOOKUPS = 32;
const MAX_HOSTNAMES = 5000;

/** Reverse DNS: the IP's hostname, or null. */
export type ReverseDns = (ip: string) => Promise<string | null>;

interface PendingSignals {
    token: string;
    body: string;
    ts: number;
}

export interface ClickBufferOptions extends EnrichOptions {
    intervalMs?: number;
    /** Clicks held in memory before new ones are dropped (if SQLite is stuck). */
    maxBuffered?: number;
    /** Fills `hostname` after insert. Off when null. */
    reverseDns?: ReverseDns | null;
}

/**
 * Collects raw clicks in memory and writes them in one transaction per tick.
 * `push()` is the only thing the redirect path calls: an array push, nothing else.
 */
export class ClickBuffer implements ClickSink {
    #pending: RawClick[] = [];
    #signals: PendingSignals[] = [];
    #hostnames: { id: number; hostname: string }[] = [];
    readonly #hostnameCache = new Map<string, string | null>();
    #lookups = 0;
    #timer: ReturnType<typeof setInterval> | null = null;
    #dropped = 0;
    #written = 0;
    readonly #db: Database;
    readonly #opts: Required<ClickBufferOptions>;
    readonly #insert;
    readonly #applySignals;
    readonly #setHostname;
    readonly #expireTokens;

    constructor(db: Database, opts: ClickBufferOptions) {
        this.#db = db;
        this.#opts = { intervalMs: 1000, maxBuffered: 100_000, reverseDns: null, ...opts };
        this.#insert = db.query<{ id: number }, (string | number | null)[]>(
            `INSERT INTO clicks (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')}) RETURNING id`
        );
        // One use per token, and only shortly after the click.
        this.#applySignals = db.query(
            `UPDATE clicks SET ${SIGNAL_COLUMNS.map(c => `${c} = ?`).join(', ')},
                timezone = COALESCE(?, timezone), language = COALESCE(?, language), token = NULL
             WHERE token = ? AND ts >= ?`
        );
        this.#setHostname = db.query('UPDATE clicks SET hostname = ? WHERE id = ?');
        this.#expireTokens = db.query(
            'UPDATE clicks SET token = NULL WHERE token IS NOT NULL AND ts < ?'
        );
    }

    push(click: RawClick): void {
        if (this.#pending.length >= this.#opts.maxBuffered) {
            this.#dropped++;
            return;
        }
        this.#pending.push(click);
    }

    pushSignals(token: string, body: string, ts: number): void {
        if (this.#signals.length >= this.#opts.maxBuffered) {
            this.#dropped++;
            return;
        }
        this.#signals.push({ token, body, ts });
    }

    start(): void {
        if (this.#timer) return;
        this.#timer = setInterval(() => this.flush(), this.#opts.intervalMs);
    }

    /** Writes everything pending. Returns the number of click rows written. */
    flush(): number {
        if (
            this.#pending.length === 0 &&
            this.#signals.length === 0 &&
            this.#hostnames.length === 0
        ) {
            return 0;
        }
        const batch = this.#pending;
        const signals = this.#signals;
        const hostnames = this.#hostnames;
        this.#pending = [];
        this.#signals = [];
        this.#hostnames = [];
        const inserted: { id: number; ip: string }[] = [];
        try {
            this.#db.transaction(() => {
                for (const click of batch) {
                    const row = enrichClick(click, this.#opts);
                    const id = this.#insert.get(...COLUMNS.map(column => row[column]))?.id;
                    if (id !== undefined && row.ip) inserted.push({ id, ip: row.ip });
                }
                // After the inserts: a click and its signals can land in the same batch.
                for (const s of signals) {
                    const parsed = parseSignals(s.body);
                    if (!parsed) continue;
                    this.#applySignals.run(
                        ...SIGNAL_COLUMNS.map(column => parsed[column]),
                        parsed.timezone,
                        parsed.language,
                        s.token,
                        s.ts - SIGNALS_WINDOW_MS
                    );
                }
                for (const h of hostnames) this.#setHostname.run(h.hostname, h.id);
                if (signals.length > 0) this.#expireTokens.run(Date.now() - SIGNALS_WINDOW_MS);
            })();
            this.#written += batch.length;
            for (const row of inserted) this.#resolve(row.id, row.ip);
            return batch.length;
        } catch (error) {
            console.error('[clicks] flush failed, will retry', error);
            const room = this.#opts.maxBuffered - this.#pending.length;
            this.#dropped += Math.max(0, batch.length - room);
            this.#pending = [...batch.slice(0, room), ...this.#pending];
            this.#signals = [...signals, ...this.#signals];
            this.#hostnames = [...hostnames, ...this.#hostnames];
            return 0;
        }
    }

    /** Looks up the IP's hostname and queues it for the next flush. */
    #resolve(id: number, ip: string): void {
        const reverseDns = this.#opts.reverseDns;
        if (!reverseDns) return;
        const cached = this.#hostnameCache.get(ip);
        if (cached !== undefined) {
            if (cached) this.#hostnames.push({ id, hostname: cached });
            return;
        }
        if (this.#lookups >= MAX_LOOKUPS) return;
        this.#lookups++;
        void reverseDns(ip)
            .catch(() => null)
            .then(hostname => {
                if (this.#hostnameCache.size >= MAX_HOSTNAMES) this.#hostnameCache.clear();
                this.#hostnameCache.set(ip, hostname);
                if (hostname) this.#hostnames.push({ id, hostname });
            })
            .finally(() => this.#lookups--);
    }

    stop(): void {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        this.flush();
    }

    get stats() {
        return {
            pending: this.#pending.length + this.#signals.length,
            written: this.#written,
            dropped: this.#dropped
        };
    }
}
