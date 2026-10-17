// Sends the outbox. Events become due, are built from the stored click at send
// time, and are retried with backoff until they are delivered or give up.
import type { Database } from 'bun:sqlite';

import type { WebhookKind, WebhookSkipCategory } from '../shared/types.ts';
import { clicksMessage, DISCORD_INTERVAL_MS, discordWaitMs, testMessage } from './discord.ts';
import {
    type ClickReader,
    createClickReader,
    type LinkClickedEvent,
    linkClickedEvent,
    scraperVerdictAt,
    skipReason,
    testEvent,
    type WebhookEvent
} from './payload.ts';
import { signedHeaders } from './sign.ts';
import { checkWebhookUrl, type ResolveHost } from './url.ts';

/** Wait before attempt 2, 3, ...; after the last one the event fails (~21 h in all). */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
/** An endpoint failing without a single success for this long is turned off. */
export const AUTO_DISABLE_AFTER_MS = 3 * 86_400_000;
/** Delivered, skipped and failed events are kept this long for the delivery log. */
export const KEEP_FINISHED_MS = 7 * 86_400_000;
/** Pending events beyond this are dropped, oldest first, so a dead endpoint can't fill the disk. */
export const MAX_PENDING = 100_000;

const MAINTENANCE_INTERVAL_MS = 60_000;
/** Due events read per Discord message; past 10 they are summarized. */
const DISCORD_BATCH = 200;
const MAX_ERROR = 300;

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DelivererOptions {
    shortOrigin: string;
    /** Discord embeds link to the link's dashboard page. */
    dashOrigin: string;
    abuseMinScore: number;
    /** Allow URLs on private networks (development). */
    allowPrivate: boolean;
    fetch?: WebhookFetch;
    resolve?: ResolveHost;
    now?: () => number;
    intervalMs?: number;
    /** Requests in flight at once to standard endpoints (Discord endpoints get one each). */
    concurrency?: number;
    timeoutMs?: number;
    /** Pending events kept at most (default MAX_PENDING). */
    maxPending?: number;
    /** Called after an endpoint is turned off automatically. */
    onDisable?: () => void;
}

/** A due event and the endpoint it goes to. */
interface DueRow {
    id: number;
    type: string;
    click_id: number | null;
    event_id: string;
    attempts: number;
    endpoint_id: number;
    kind: WebhookKind;
    url: string;
    secret: string | null;
    skip: string;
    include_ip: number;
}

/** What one attempt came to. */
type Outcome =
    | { kind: 'delivered'; status: number }
    | { kind: 'skipped'; reason: string }
    /** Not ready to send; tried again at `dueAt` without counting an attempt. */
    | { kind: 'deferred'; dueAt: number }
    | { kind: 'failed'; status: number | null; error: string };

export class WebhookDeliverer {
    readonly #db: Database;
    readonly #opts: Required<Omit<DelivererOptions, 'resolve' | 'onDisable'>> &
        Pick<DelivererOptions, 'resolve' | 'onDisable'>;
    readonly #readClick: ClickReader;
    /** Standard events being sent, by event id. */
    readonly #inFlight = new Map<number, Promise<void>>();
    /** Discord endpoints with a message being sent, by endpoint id. */
    readonly #discordBusy = new Map<number, Promise<void>>();
    /** Earliest time each Discord endpoint may get its next message. */
    readonly #discordNext = new Map<number, number>();
    #timer: ReturnType<typeof setInterval> | null = null;
    #lastMaintenance = 0;
    #sent = 0;
    #failedAttempts = 0;

    constructor(db: Database, opts: DelivererOptions) {
        this.#db = db;
        this.#opts = {
            ...opts,
            fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
            now: opts.now ?? Date.now,
            intervalMs: opts.intervalMs ?? 1000,
            concurrency: opts.concurrency ?? 4,
            timeoutMs: opts.timeoutMs ?? 10_000,
            maxPending: opts.maxPending ?? MAX_PENDING
        };
        this.#readClick = createClickReader(db);
    }

    start(): void {
        if (this.#timer) return;
        this.#timer = setInterval(() => void this.tick(), this.#opts.intervalMs);
    }

    async stop(): Promise<void> {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        await Promise.all([...this.#inFlight.values(), ...this.#discordBusy.values()]);
    }

    /** Starts every due event there is room for and waits for those to finish. */
    async tick(): Promise<void> {
        const now = this.#opts.now();
        if (now - this.#lastMaintenance >= MAINTENANCE_INTERVAL_MS) this.maintain(now);
        await Promise.all([...this.#startStandard(now), ...this.#startDiscord(now)]);
    }

    #startStandard(now: number): Promise<void>[] {
        const room = this.#opts.concurrency - this.#inFlight.size;
        if (room <= 0) return [];
        const due = this.#dueQuery("e.kind = 'standard'")
            .all(now, room + this.#inFlight.size)
            .filter(row => !this.#inFlight.has(row.id))
            .slice(0, room);
        return due.map(row => {
            const run = this.#attempt(row).finally(() => this.#inFlight.delete(row.id));
            this.#inFlight.set(row.id, run);
            return run;
        });
    }

    /** One batch per Discord endpoint that has due events, isn't busy and isn't paced. */
    #startDiscord(now: number): Promise<void>[] {
        const endpoints = this.#db
            .query<{ id: number }, [number]>(
                `SELECT DISTINCT ev.endpoint_id AS id
                 FROM webhook_events ev JOIN webhook_endpoints e ON e.id = ev.endpoint_id
                 WHERE ev.status = 'pending' AND ev.due_at <= ? AND e.enabled = 1 AND e.kind = 'discord'`
            )
            .all(now)
            .map(r => r.id)
            .filter(id => !this.#discordBusy.has(id) && (this.#discordNext.get(id) ?? 0) <= now);
        return endpoints.map(id => {
            const run = this.#discordBatch(id, now).finally(() => this.#discordBusy.delete(id));
            this.#discordBusy.set(id, run);
            return run;
        });
    }

    #dueQuery(where: string) {
        return this.#db.query<DueRow, number[]>(
            `SELECT ev.id, ev.type, ev.click_id, ev.event_id, ev.attempts, ev.endpoint_id,
                    e.kind, e.url, e.secret, e.skip, e.include_ip
             FROM webhook_events ev JOIN webhook_endpoints e ON e.id = ev.endpoint_id
             WHERE ev.status = 'pending' AND ev.due_at <= ? AND e.enabled = 1 AND ${where}
             ORDER BY ev.due_at, ev.id LIMIT ?`
        );
    }

    /** Prunes old finished events and caps the pending ones. */
    maintain(now = this.#opts.now()): void {
        this.#lastMaintenance = now;
        this.#db
            .query("DELETE FROM webhook_events WHERE status != 'pending' AND finished_at < ?")
            .run(now - KEEP_FINISHED_MS);
        this.#db
            .query(
                `UPDATE webhook_events SET status = 'failed', last_error = 'Dropped: too many pending events', finished_at = ?
                 WHERE id IN (SELECT id FROM webhook_events WHERE status = 'pending'
                              ORDER BY id DESC LIMIT -1 OFFSET ?)`
            )
            .run(now, this.#opts.maxPending);
    }

    async #attempt(row: DueRow): Promise<void> {
        let outcome: Outcome;
        try {
            outcome = await this.#deliver(row);
        } catch (error) {
            outcome = { kind: 'failed', status: null, error: errorMessage(error) };
        }
        this.#record(row, outcome);
    }

    async #deliver(row: DueRow): Promise<Outcome> {
        const now = this.#opts.now();
        const event = this.#build(row, now);
        if ('reason' in event) return { kind: 'skipped', reason: event.reason };
        if ('dueAt' in event) return { kind: 'deferred', dueAt: event.dueAt };
        return this.#sendStandard(row, event, now);
    }

    /**
     * Sends a Discord endpoint's due events as one message: test events on their
     * own, clicks batched (summarized past 10). Paced by DISCORD_INTERVAL_MS and
     * Discord's rate-limit headers; a 429 waits without counting as an attempt.
     */
    async #discordBatch(endpointId: number, now: number): Promise<void> {
        const rows = this.#dueQuery('ev.endpoint_id = ?').all(now, endpointId, DISCORD_BATCH);
        const first = rows[0];
        if (!first) return;
        const tests = rows.filter(row => row.type === 'webhook.test');
        const clicks: { row: DueRow; event: LinkClickedEvent }[] = [];
        if (tests.length === 0) {
            for (const row of rows) {
                const event = this.#build(row, now);
                if ('reason' in event) this.#record(row, { kind: 'skipped', reason: event.reason });
                else if ('dueAt' in event)
                    this.#record(row, { kind: 'deferred', dueAt: event.dueAt });
                else if (event.type === 'link.clicked') clicks.push({ row, event });
            }
        }
        const batch = tests.length > 0 ? tests : clicks.map(c => c.row);
        if (batch.length === 0) return;
        const message =
            tests.length > 0
                ? testMessage()
                : clicksMessage(
                      clicks.map(c => c.event),
                      this.#opts.dashOrigin
                  );

        this.#discordNext.set(endpointId, now + DISCORD_INTERVAL_MS);
        let res: Response;
        try {
            res = await this.#post(
                first.url,
                { 'Content-Type': 'application/json' },
                JSON.stringify(message)
            );
        } catch (error) {
            const outcome: Outcome = { kind: 'failed', status: null, error: errorMessage(error) };
            for (const row of batch) this.#record(row, outcome);
            return;
        }
        const wait = await discordWaitMs(res);
        await res.body?.cancel().catch(() => null);
        if (wait !== null) {
            this.#discordNext.set(endpointId, now + Math.max(wait, DISCORD_INTERVAL_MS));
        }
        if (res.status === 429) return;
        if (res.status === 401 || res.status === 404) {
            this.disable(endpointId, 'Discord says this webhook no longer exists', now);
            return;
        }
        const outcome: Outcome = res.ok
            ? { kind: 'delivered', status: res.status }
            : { kind: 'failed', status: res.status, error: `HTTP ${res.status}` };
        for (const row of batch) this.#record(row, outcome);
    }

    /** The event to send, why not to send it, or when it will be ready. */
    #build(row: DueRow, now: number): WebhookEvent | { reason: string } | { dueAt: number } {
        if (row.type === 'webhook.test') return testEvent(now);
        if (row.click_id === null) return { reason: 'No click' };
        const click = this.#readClick(row.click_id);
        if (!click) return { reason: 'Click was deleted' };
        if (click.slug === null || click.url === null) return { reason: 'Link was deleted' };
        const skip = new Set(JSON.parse(row.skip) as WebhookSkipCategory[]);
        const reason = skipReason(click, skip, this.#opts.abuseMinScore);
        if (reason) return { reason: `Skipped: ${reason}` };
        const verdictAt = scraperVerdictAt(click, skip);
        if (verdictAt !== null && verdictAt > now) return { dueAt: verdictAt };
        return linkClickedEvent(
            { ...click, slug: click.slug, url: click.url },
            { shortOrigin: this.#opts.shortOrigin, includeIp: row.include_ip === 1, now }
        );
    }

    async #sendStandard(row: DueRow, event: WebhookEvent, now: number): Promise<Outcome> {
        if (!row.secret) return { kind: 'failed', status: null, error: 'Endpoint has no secret' };
        const body = JSON.stringify(event);
        const res = await this.#post(
            row.url,
            signedHeaders(row.secret, row.event_id, Math.floor(now / 1000), body),
            body
        );
        await res.body?.cancel().catch(() => null);
        return res.ok
            ? { kind: 'delivered', status: res.status }
            : { kind: 'failed', status: res.status, error: `HTTP ${res.status}` };
    }

    /** POSTs to a webhook URL, connecting to the address its check resolved. */
    async #post(url: string, headers: Record<string, string>, body: string): Promise<Response> {
        const target = await checkWebhookUrl(url, {
            allowPrivate: this.#opts.allowPrivate,
            resolve: this.#opts.resolve
        });
        return this.#opts.fetch(target.url, {
            method: 'POST',
            headers: target.host ? { ...headers, Host: target.host } : headers,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(this.#opts.timeoutMs),
            ...(target.serverName && { tls: { serverName: target.serverName } })
        });
    }

    #record(row: DueRow, outcome: Outcome): void {
        const now = this.#opts.now();
        const attempts = row.attempts + 1;
        switch (outcome.kind) {
            case 'deferred':
                this.#db
                    .query(
                        "UPDATE webhook_events SET due_at = ? WHERE id = ? AND status = 'pending'"
                    )
                    .run(outcome.dueAt, row.id);
                return;
            case 'skipped':
                this.#db
                    .query(
                        "UPDATE webhook_events SET status = 'skipped', last_error = ?, finished_at = ? WHERE id = ?"
                    )
                    .run(outcome.reason, now, row.id);
                return;
            case 'delivered':
                this.#sent++;
                this.#db.transaction(() => {
                    this.#db
                        .query(
                            `UPDATE webhook_events SET status = 'delivered', attempts = ?, last_status = ?,
                                last_error = NULL, finished_at = ? WHERE id = ?`
                        )
                        .run(attempts, outcome.status, now, row.id);
                    this.#db
                        .query('UPDATE webhook_endpoints SET failing_since = NULL WHERE id = ?')
                        .run(row.endpoint_id);
                })();
                return;
            case 'failed': {
                this.#failedAttempts++;
                const delay = RETRY_DELAYS_MS[attempts - 1];
                const error = outcome.error.slice(0, MAX_ERROR);
                // Only while still pending: turning the endpoint off mid-request skipped it.
                const failingSince = this.#db.transaction(() => {
                    if (delay === undefined) {
                        this.#db
                            .query(
                                `UPDATE webhook_events SET status = 'failed', attempts = ?, last_status = ?,
                                    last_error = ?, finished_at = ? WHERE id = ? AND status = 'pending'`
                            )
                            .run(attempts, outcome.status, error, now, row.id);
                    } else {
                        this.#db
                            .query(
                                `UPDATE webhook_events SET attempts = ?, last_status = ?, last_error = ?,
                                    due_at = ? WHERE id = ? AND status = 'pending'`
                            )
                            .run(attempts, outcome.status, error, now + delay, row.id);
                    }
                    // Read back: a delivery that finished meanwhile may have ended the streak.
                    return (
                        this.#db
                            .query<{ failing_since: number }, [number, number]>(
                                `UPDATE webhook_endpoints SET failing_since = COALESCE(failing_since, ?)
                                 WHERE id = ? RETURNING failing_since`
                            )
                            .get(now, row.endpoint_id)?.failing_since ?? now
                    );
                })();
                if (now - failingSince >= AUTO_DISABLE_AFTER_MS) {
                    this.disable(row.endpoint_id, 'Failing for 3 days', now);
                }
            }
        }
    }

    /** Turns an endpoint off and skips what it had pending. False if it was already off. */
    disable(endpointId: number, reason: string, now = this.#opts.now()): boolean {
        const changed = this.#db.transaction(() => {
            const { changes } = this.#db
                .query(
                    'UPDATE webhook_endpoints SET enabled = 0, disabled_reason = ?, updated_at = ? WHERE id = ? AND enabled = 1'
                )
                .run(reason, now, endpointId);
            if (changes > 0)
                skipPending(this.#db, endpointId, `Endpoint turned off: ${reason}`, now);
            return changes > 0;
        })();
        if (changed) this.#opts.onDisable?.();
        return changed;
    }

    get stats() {
        return {
            inFlight: this.#inFlight.size + this.#discordBusy.size,
            sent: this.#sent,
            failedAttempts: this.#failedAttempts
        };
    }
}

/** Marks an endpoint's pending events skipped (it was turned off or deleted). */
export function skipPending(db: Database, endpointId: number, reason: string, now: number): void {
    db.query(
        `UPDATE webhook_events SET status = 'skipped', last_error = ?, finished_at = ?
         WHERE endpoint_id = ? AND status = 'pending'`
    ).run(reason, now, endpointId);
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.name === 'TimeoutError' ? 'Timed out' : error.message;
    }
    return String(error);
}
