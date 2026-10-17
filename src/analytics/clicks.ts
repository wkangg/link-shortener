import type { Database } from 'bun:sqlite';

import type { ClickSink, RawClick } from '../shared/types.ts';
import { refineApple } from './apple.ts';
import { ClickClassifier, SIGNALS_WINDOW_MS } from './classify.ts';
import { isDatacenterHostname } from './datacenter.ts';
import {
    type ClickRow,
    type DeviceSignals,
    enrichClick,
    type EnrichOptions,
    parseSignals
} from './enrich.ts';
import { computeFingerprint } from './fingerprint.ts';

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
    'os_version',
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
    'longitude',
    'fingerprint',
    'is_datacenter',
    'js'
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
    'touch_points',
    'webdriver'
] as const satisfies readonly (keyof DeviceSignals)[];

/** Unused tokens are cleared (and their clicks reclassified) at most this often. */
const EXPIRE_INTERVAL_MS = 60_000;
/** Reverse DNS lookups in flight at once; clicks beyond it just get no hostname. */
const MAX_LOOKUPS = 32;
const MAX_HOSTNAMES = 5000;

/** Fills reputation columns on a click after insert (see analytics/reputation.ts). */
export interface ClickAnnotator {
    annotate(id: number, ip: string): void;
}

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
    /** Fills `abuse_score` and `isp` after insert. Off when null. */
    reputation?: ClickAnnotator | null;
    /** Sets `vpn` and `scraper` as a click's facts arrive. */
    classifier?: ClickClassifier;
}

/**
 * Collects raw clicks in memory and writes them in one transaction per tick.
 * `push()` is the only thing the redirect path calls: an array push, nothing else.
 */
export class ClickBuffer implements ClickSink {
    #pending: RawClick[] = [];
    #signals: PendingSignals[] = [];
    #hostnames: { id: number; hostname: string; datacenter: 0 | 1 }[] = [];
    readonly #hostnameCache = new Map<string, string | null>();
    #lookups = 0;
    #timer: ReturnType<typeof setInterval> | null = null;
    #dropped = 0;
    #written = 0;
    #lastExpiry = Date.now();
    readonly #db: Database;
    readonly #opts: Required<Omit<ClickBufferOptions, 'classifier'>>;
    readonly #classifier: ClickClassifier;
    readonly #insert;
    readonly #rowForToken;
    readonly #applySignals;
    readonly #setHostname;
    readonly #expireTokens;

    constructor(db: Database, opts: ClickBufferOptions) {
        this.#db = db;
        this.#opts = {
            intervalMs: 1000,
            maxBuffered: 100_000,
            reverseDns: null,
            reputation: null,
            ...opts
        };
        this.#classifier = opts.classifier ?? new ClickClassifier(db);
        this.#insert = db.query<{ id: number }, (string | number | null)[]>(
            `INSERT INTO clicks (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')}) RETURNING id`
        );
        // The user agent and headers of the click a token belongs to, so its
        // fingerprint can be recomputed with the browser signals folded in (and
        // its Apple model narrowed down by screen size).
        this.#rowForToken = db.query<
            {
                id: number;
                ua: string | null;
                language: string | null;
                timezone: string | null;
                os: string | null;
                model: string | null;
            },
            [string, number]
        >(
            `SELECT id, user_agent AS ua, language, timezone, os, device_model AS model
             FROM clicks WHERE token = ? AND ts >= ? LIMIT 1`
        );
        // One use per token, and only shortly after the click.
        this.#applySignals = db.query(
            `UPDATE clicks SET ${SIGNAL_COLUMNS.map(c => `${c} = ?`).join(', ')},
                timezone = COALESCE(?, timezone), language = COALESCE(?, language),
                fingerprint = COALESCE(?, fingerprint), os = COALESCE(?, os),
                os_version = COALESCE(?, os_version), device = COALESCE(?, device),
                device_model = COALESCE(?, device_model), js = 1, token = NULL
             WHERE token = ? AND ts >= ?`
        );
        this.#setHostname = db.query(
            'UPDATE clicks SET hostname = ?, is_datacenter = ? WHERE id = ?'
        );
        this.#expireTokens = db.query<{ id: number }, [number]>(
            'UPDATE clicks SET token = NULL WHERE token IS NOT NULL AND ts < ? RETURNING id'
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
        const now = Date.now();
        const expire = now - this.#lastExpiry >= EXPIRE_INTERVAL_MS;
        if (
            this.#pending.length === 0 &&
            this.#signals.length === 0 &&
            this.#hostnames.length === 0 &&
            !expire
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
        // Clicks whose facts changed, to classify once everything is written.
        const touched: number[] = [];
        try {
            this.#db.transaction(() => {
                for (const click of batch) {
                    const row = enrichClick(click, this.#opts);
                    const id = this.#insert.get(...COLUMNS.map(column => row[column]))?.id;
                    if (id !== undefined) touched.push(id);
                    if (id !== undefined && row.ip) {
                        inserted.push({ id, ip: row.ip });
                        this.#opts.reputation?.annotate(id, row.ip);
                    }
                }
                // After the inserts: a click and its signals can land in the same batch.
                for (const s of signals) {
                    const parsed = parseSignals(s.body);
                    if (!parsed) continue;
                    const since = s.ts - SIGNALS_WINDOW_MS;
                    const click = this.#rowForToken.get(s.token, since);
                    if (click) touched.push(click.id);
                    const fingerprint = click
                        ? computeFingerprint({
                              ua: click.ua,
                              language: parsed.language ?? click.language,
                              timezone: parsed.timezone ?? click.timezone,
                              screen: parsed.screen,
                              gpu: parsed.gpu,
                              platform: parsed.platform,
                              memory: parsed.memory,
                              touchPoints: parsed.touch_points
                          })
                        : null;
                    const apple = click
                        ? refineApple(click, {
                              screen: parsed.screen,
                              touchPoints: parsed.touch_points
                          })
                        : null;
                    this.#applySignals.run(
                        ...SIGNAL_COLUMNS.map(column => parsed[column]),
                        parsed.timezone,
                        parsed.language,
                        fingerprint,
                        apple?.os ?? null,
                        apple?.osVersion ?? null,
                        apple?.device ?? null,
                        apple?.model ?? null,
                        s.token,
                        since
                    );
                }
                for (const h of hostnames) {
                    this.#setHostname.run(h.hostname, h.datacenter, h.id);
                    touched.push(h.id);
                }
                if (signals.length > 0 || expire) {
                    // The page never reported back: that's a fact too.
                    for (const row of this.#expireTokens.all(now - SIGNALS_WINDOW_MS)) {
                        touched.push(row.id);
                    }
                    this.#lastExpiry = now;
                }
                this.#classifier.ids(touched);
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
            if (cached) this.#queueHostname(id, cached);
            return;
        }
        if (this.#lookups >= MAX_LOOKUPS) return;
        this.#lookups++;
        void reverseDns(ip)
            .catch(() => null)
            .then(hostname => {
                if (this.#hostnameCache.size >= MAX_HOSTNAMES) this.#hostnameCache.clear();
                this.#hostnameCache.set(ip, hostname);
                if (hostname) this.#queueHostname(id, hostname);
            })
            .finally(() => this.#lookups--);
    }

    #queueHostname(id: number, hostname: string): void {
        this.#hostnames.push({ id, hostname, datacenter: isDatacenterHostname(hostname) ? 1 : 0 });
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
