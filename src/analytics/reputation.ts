// IP reputation from AbuseIPDB (optional, needs ABUSEIPDB_API_KEY). Each public
// IP is checked once per TTL and the result is cached in `ip_reputation`, then
// copied onto every click from that IP: the abuse confidence score (clicks at or
// above ABUSEIPDB_MIN_SCORE are hidden by default) and the ISP. AbuseIPDB's usage
// type also marks datacenter ranges much more reliably than reverse DNS can.
//
// Lookups run in the background, a few at a time, within the daily quota (the
// free plan allows 1,000 checks a day). The redirect path never waits on them.
import type { Database } from 'bun:sqlite';

import type { ClickAnnotator } from './clicks.ts';
import { isPublicIp } from './hostname.ts';

/** What AbuseIPDB reports for one address. */
export interface Reputation {
    /** Abuse confidence, 0-100. */
    score: number;
    /** Reports in the last 90 days. */
    reports: number;
    /** e.g. "Data Center/Web Hosting/Transit" or "Fixed Line ISP". */
    usageType: string | null;
    isp: string | null;
}

export type CheckIp = (ip: string) => Promise<Reputation>;

/** Thrown by a CheckIp when the service says to slow down. */
export class RateLimitedError extends Error {
    readonly retryAt: number;

    constructor(retryAt: number) {
        super('Rate limited');
        this.name = 'RateLimitedError';
        this.retryAt = retryAt;
    }
}

/** AbuseIPDB usage types that mean "not a person on a home or mobile connection". */
const DATACENTER_USAGE = [
    'Data Center/Web Hosting/Transit',
    'Content Delivery Network',
    'Search Engine Spider'
];
const DATACENTER_SET = new Set(DATACENTER_USAGE);

export function isDatacenterUsage(usageType: string | null): boolean {
    return usageType !== null && DATACENTER_SET.has(usageType);
}

const DAY = 86_400_000;
const MAX_TEXT = 200;
const MAX_QUEUE = 5000;
const ERROR_LOG_INTERVAL_MS = 60_000;

/** AbuseIPDB's /check endpoint, with a timeout. `baseUrl` is for tests. */
export function createAbuseIpdb(
    apiKey: string,
    opts: { timeoutMs?: number; baseUrl?: string } = {}
): CheckIp {
    const base = opts.baseUrl ?? 'https://api.abuseipdb.com';
    const timeoutMs = opts.timeoutMs ?? 5000;
    return async ip => {
        const url = `${base}/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`;
        const res = await fetch(url, {
            headers: { Key: apiKey, Accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (res.status === 429) {
            const seconds = Number(res.headers.get('retry-after'));
            const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000;
            throw new RateLimitedError(Date.now() + wait);
        }
        if (!res.ok) throw new Error(`AbuseIPDB answered ${res.status} ${res.statusText}`);
        const body = (await res.json()) as { data?: Record<string, unknown> };
        return parseCheck(body.data ?? {});
    };
}

/** A whole number in [0, max], or 0. */
function int(value: unknown, max: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(Math.round(value), 0), max)
        : 0;
}

/** Trimmed, capped text, or null when empty. */
function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== ''
        ? value.trim().slice(0, MAX_TEXT)
        : null;
}

/** The `data` object of an AbuseIPDB /check response, validated. */
export function parseCheck(data: Record<string, unknown>): Reputation {
    return {
        score: int(data.abuseConfidenceScore, 100),
        reports: int(data.totalReports, 1_000_000_000),
        usageType: text(data.usageType),
        isp: text(data.isp)
    };
}

export interface IpReputationOptions {
    check: CheckIp;
    /** Lookups per UTC day. */
    dailyLimit?: number;
    /** How long a result is trusted before the IP is checked again. */
    ttlMs?: number;
    /** Lookups in flight at once. */
    concurrency?: number;
    now?: () => number;
}

interface Known extends Reputation {
    checkedAt: number;
}

type Values = [score: number, isp: string | null, datacenter: 0 | 1];

export class IpReputation implements ClickAnnotator {
    readonly #db: Database;
    readonly #check: CheckIp;
    readonly #dailyLimit: number;
    readonly #ttl: number;
    readonly #concurrency: number;
    readonly #now: () => number;
    readonly #known = new Map<string, Known>();
    /** Waiting IPs, oldest first (a Set keeps insertion order). */
    readonly #queued = new Set<string>();
    readonly #inFlight = new Set<string>();
    #day = -1;
    #used = 0;
    #pausedUntil = 0;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #stopped = false;
    #lastErrorLog = 0;
    readonly #upsert;
    readonly #applyToIp;
    readonly #applyToId;
    readonly #checkedSince;

    constructor(db: Database, opts: IpReputationOptions) {
        this.#db = db;
        this.#check = opts.check;
        this.#dailyLimit = opts.dailyLimit ?? 1000;
        this.#ttl = opts.ttlMs ?? 7 * DAY;
        this.#concurrency = opts.concurrency ?? 2;
        this.#now = opts.now ?? Date.now;

        const rows = db
            .query<Known & { ip: string }, []>(
                `SELECT ip, abuse_score AS score, reports, usage_type AS usageType, isp,
                        checked_at AS checkedAt
                 FROM ip_reputation`
            )
            .all();
        for (const { ip, ...known } of rows) this.#known.set(ip, known);

        this.#upsert = db.query(
            `INSERT INTO ip_reputation (ip, abuse_score, reports, usage_type, isp, checked_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (ip) DO UPDATE SET abuse_score = excluded.abuse_score,
                reports = excluded.reports, usage_type = excluded.usage_type,
                isp = excluded.isp, checked_at = excluded.checked_at`
        );
        // A datacenter verdict only ever adds the flag (reverse DNS may have set it already).
        const set = 'abuse_score = ?, isp = ?, is_datacenter = MAX(is_datacenter, ?)';
        this.#applyToIp = db.query(`UPDATE clicks SET ${set} WHERE ip = ?`);
        this.#applyToId = db.query(`UPDATE clicks SET ${set} WHERE id = ?`);
        this.#checkedSince = db.query<{ n: number }, [number]>(
            'SELECT COUNT(*) AS n FROM ip_reputation WHERE checked_at >= ?'
        );
    }

    /**
     * For a click just inserted: copies the IP's known reputation onto it, and
     * queues a lookup if the IP was never checked or its result is stale.
     */
    annotate(id: number, ip: string): void {
        const known = this.#known.get(ip);
        if (known) this.#applyToId.run(...values(known), id);
        this.request(ip);
    }

    /**
     * Queues a lookup unless the IP is private, already fresh, or already queued.
     * Returns whether it was queued.
     */
    request(ip: string): boolean {
        if (this.#stopped || this.#queued.has(ip) || this.#inFlight.has(ip)) return false;
        if (!isPublicIp(ip) || this.#queued.size >= MAX_QUEUE) return false;
        const known = this.#known.get(ip);
        if (known && this.#now() - known.checkedAt <= this.#ttl) return false;
        this.#queued.add(ip);
        this.#pump();
        return true;
    }

    /**
     * Catches up on clicks recorded before reputation was on (or while the quota
     * ran out): copies cached results onto clicks that lack them, then queues the
     * busiest unchecked IPs from the last `days` days. Returns the number queued.
     */
    backfill(days = 30): number {
        const now = this.#now();
        const marks = DATACENTER_USAGE.map(() => '?').join(', ');
        this.#db
            .query(
                `UPDATE clicks SET abuse_score = r.abuse_score, isp = r.isp,
                    is_datacenter = MAX(clicks.is_datacenter,
                        CASE WHEN r.usage_type IN (${marks}) THEN 1 ELSE 0 END)
                 FROM ip_reputation r
                 WHERE r.ip = clicks.ip AND clicks.abuse_score IS NULL`
            )
            .run(...DATACENTER_USAGE);
        const rows = this.#db
            .query<{ ip: string }, [number, number, number]>(
                `SELECT c.ip FROM clicks c LEFT JOIN ip_reputation r ON r.ip = c.ip
                 WHERE c.ts >= ? AND c.ip IS NOT NULL AND c.is_bot = 0
                   AND (r.ip IS NULL OR r.checked_at < ?)
                 GROUP BY c.ip ORDER BY COUNT(*) DESC LIMIT ?`
            )
            .all(now - days * DAY, now - this.#ttl, MAX_QUEUE);
        let queued = 0;
        for (const row of rows) if (this.request(row.ip)) queued++;
        return queued;
    }

    stop(): void {
        this.#stopped = true;
        this.#queued.clear();
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
    }

    get stats() {
        return {
            known: this.#known.size,
            queued: this.#queued.size,
            inFlight: this.#inFlight.size,
            usedToday: this.#used
        };
    }

    #pump(): void {
        while (!this.#stopped && this.#inFlight.size < this.#concurrency && this.#queued.size > 0) {
            const now = this.#now();
            if (now < this.#pausedUntil) {
                this.#resumeAt(this.#pausedUntil);
                return;
            }
            if (!this.#hasQuota(now)) {
                this.#resumeAt((Math.floor(now / DAY) + 1) * DAY);
                return;
            }
            const ip = this.#queued.values().next().value;
            if (ip === undefined) return;
            this.#queued.delete(ip);
            this.#inFlight.add(ip);
            this.#used++;
            void this.#check(ip)
                .then(
                    reputation => this.#store(ip, reputation),
                    (error: unknown) => this.#failed(ip, error)
                )
                .finally(() => {
                    this.#inFlight.delete(ip);
                    this.#pump();
                });
        }
    }

    #hasQuota(now: number): boolean {
        const day = Math.floor(now / DAY);
        if (day !== this.#day) {
            // Counted from the table, so a restart doesn't reset the day's usage.
            this.#day = day;
            this.#used = this.#checkedSince.get(day * DAY)?.n ?? 0;
        }
        return this.#used < this.#dailyLimit;
    }

    #resumeAt(at: number): void {
        if (this.#timer) return;
        const delay = Math.max(at - this.#now(), 1000);
        this.#timer = setTimeout(() => {
            this.#timer = null;
            this.#pump();
        }, delay);
        this.#timer.unref();
    }

    #store(ip: string, reputation: Reputation): void {
        if (this.#stopped) return;
        try {
            const checkedAt = this.#now();
            this.#upsert.run(
                ip,
                reputation.score,
                reputation.reports,
                reputation.usageType,
                reputation.isp,
                checkedAt
            );
            this.#known.set(ip, { ...reputation, checkedAt });
            this.#applyToIp.run(...values(reputation), ip);
        } catch (error) {
            this.#log(error);
        }
    }

    #failed(ip: string, error: unknown): void {
        if (error instanceof RateLimitedError) {
            this.#pausedUntil = error.retryAt;
            if (!this.#stopped) this.#queued.add(ip);
            return;
        }
        // Not retried right away; the next backfill picks the IP up again.
        this.#log(error);
    }

    #log(error: unknown): void {
        const now = this.#now();
        if (now - this.#lastErrorLog < ERROR_LOG_INTERVAL_MS) return;
        this.#lastErrorLog = now;
        console.error(
            '[reputation] lookup failed:',
            error instanceof Error ? error.message : error
        );
    }
}

function values(reputation: Reputation): Values {
    return [reputation.score, reputation.isp, isDatacenterUsage(reputation.usageType) ? 1 : 0];
}
