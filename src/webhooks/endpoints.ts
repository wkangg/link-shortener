// Webhook endpoints as the dashboard manages them.
import type { Database } from 'bun:sqlite';

import type { CreateWebhookInput, UpdateWebhookInput } from '../dashboard/schemas.ts';
import { isDiscordWebhookUrl, maskDiscordUrl } from '../shared/discord.ts';
import {
    DEFAULT_WEBHOOK_SKIP,
    type WebhookEndpoint,
    type WebhookEndpointCreated,
    type WebhookEventRow,
    type WebhookKind,
    type WebhookLastEvent,
    type WebhookSkipCategory
} from '../shared/types.ts';
import { KEEP_FINISHED_MS, skipPending } from './deliverer.ts';
import type { WebhookOutbox } from './outbox.ts';
import { generateSecret } from './sign.ts';
import { checkWebhookUrl, type ResolveHost, WebhookUrlError } from './url.ts';

interface EndpointRow {
    id: number;
    kind: WebhookKind;
    url: string;
    description: string | null;
    secret: string | null;
    enabled: number;
    tags: string;
    skip: string;
    include_ip: number;
    disabled_reason: string | null;
    failing_since: number | null;
    created_at: number;
    updated_at: number;
}

interface EventRow {
    id: number;
    endpoint_id: number;
    type: WebhookEventRow['type'];
    click_id: number | null;
    event_id: string;
    status: WebhookEventRow['status'];
    due_at: number;
    attempts: number;
    last_status: number | null;
    last_error: string | null;
    created_at: number;
    finished_at: number | null;
}

/** A webhook request the dashboard can't carry out (400 or 409). */
export class WebhookRequestError extends Error {
    readonly status: 400 | 409;
    constructor(message: string, status: 400 | 409 = 400) {
        super(message);
        this.name = 'WebhookRequestError';
        this.status = status;
    }
}

export interface EndpointRepoOptions {
    /** Allow URLs on private networks (development). */
    allowPrivate: boolean;
    resolve?: ResolveHost;
    now?: () => number;
}

export class EndpointRepo {
    readonly #db: Database;
    readonly #outbox: WebhookOutbox;
    readonly #opts: EndpointRepoOptions;
    readonly #now: () => number;

    constructor(db: Database, outbox: WebhookOutbox, opts: EndpointRepoOptions) {
        this.#db = db;
        this.#outbox = outbox;
        this.#opts = opts;
        this.#now = opts.now ?? Date.now;
    }

    list(): WebhookEndpoint[] {
        const rows = this.#db
            .query<EndpointRow, []>('SELECT * FROM webhook_endpoints ORDER BY id')
            .all();
        return rows.map(row => this.#toEndpoint(row));
    }

    get(id: number): WebhookEndpoint | null {
        const row = this.#row(id);
        return row ? this.#toEndpoint(row) : null;
    }

    async create(input: CreateWebhookInput): Promise<WebhookEndpointCreated> {
        const kind = input.kind ?? (isDiscordWebhookUrl(input.url) ? 'discord' : 'standard');
        await this.#checkUrl(input.url, kind);
        const secret = kind === 'standard' ? generateSecret() : null;
        const now = this.#now();
        const row = this.#db
            .query<EndpointRow, (string | number | null)[]>(
                `INSERT INTO webhook_endpoints
                    (kind, url, description, secret, enabled, tags, skip, include_ip, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
            )
            .get(
                kind,
                input.url,
                input.description ?? null,
                secret,
                input.enabled === false ? 0 : 1,
                JSON.stringify(input.tags ?? []),
                JSON.stringify(input.skip ?? DEFAULT_WEBHOOK_SKIP),
                input.includeIp ? 1 : 0,
                now,
                now
            );
        if (!row) throw new Error('Insert returned no row');
        this.#outbox.refresh();
        return { ...this.#toEndpoint(row), secret };
    }

    async update(id: number, patch: UpdateWebhookInput): Promise<WebhookEndpoint | null> {
        const existing = this.#row(id);
        if (!existing) return null;
        if (patch.url !== undefined) await this.#checkUrl(patch.url, existing.kind);

        const now = this.#now();
        const sets: string[] = ['updated_at = ?'];
        const params: (string | number | null)[] = [now];
        const column = (name: string, value: string | number | null) => {
            sets.push(`${name} = ?`);
            params.push(value);
        };
        if (patch.url !== undefined) column('url', patch.url);
        if (patch.description !== undefined) column('description', patch.description);
        if (patch.tags !== undefined) column('tags', JSON.stringify(patch.tags));
        if (patch.skip !== undefined) column('skip', JSON.stringify(patch.skip));
        if (patch.includeIp !== undefined) column('include_ip', patch.includeIp ? 1 : 0);
        if (patch.enabled !== undefined) {
            column('enabled', patch.enabled ? 1 : 0);
            // Turning it back on starts over.
            if (patch.enabled) {
                column('disabled_reason', null);
                column('failing_since', null);
            }
        }

        this.#db.transaction(() => {
            this.#db
                .query(`UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE id = ?`)
                .run(...params, id);
            if (patch.enabled === false && existing.enabled === 1) {
                skipPending(this.#db, id, 'Endpoint turned off', now);
            }
        })();
        this.#outbox.refresh();
        return this.get(id);
    }

    delete(id: number): boolean {
        const { changes } = this.#db.query('DELETE FROM webhook_endpoints WHERE id = ?').run(id);
        this.#outbox.refresh();
        return changes > 0;
    }

    /** A new signing secret; the old one stops working at once. */
    rotateSecret(id: number): string | null {
        const row = this.#row(id);
        if (!row) return null;
        if (row.kind !== 'standard') {
            throw new WebhookRequestError('Discord endpoints have no signing secret');
        }
        const secret = generateSecret();
        this.#db
            .query('UPDATE webhook_endpoints SET secret = ?, updated_at = ? WHERE id = ?')
            .run(secret, this.#now(), id);
        return secret;
    }

    /** Queues a webhook.test event, sent on the deliverer's next tick. */
    sendTest(id: number): WebhookEventRow | null {
        const row = this.#row(id);
        if (!row) return null;
        if (row.enabled !== 1) throw new WebhookRequestError('Turn the endpoint on first', 409);
        const now = this.#now();
        const event = this.#db
            .query<EventRow, [number, number, number]>(
                `INSERT INTO webhook_events (endpoint_id, type, event_id, due_at, created_at)
                 VALUES (?, 'webhook.test', 'evt_' || lower(hex(randomblob(12))), ?, ?) RETURNING *`
            )
            .get(id, now, now);
        return event ? toEvent(event) : null;
    }

    /** Recent events for an endpoint, newest first. */
    events(id: number, limit = 50): WebhookEventRow[] | null {
        if (!this.#row(id)) return null;
        return this.#db
            .query<EventRow, [number, number]>(
                'SELECT * FROM webhook_events WHERE endpoint_id = ? ORDER BY id DESC LIMIT ?'
            )
            .all(id, Math.min(Math.max(limit, 1), 200))
            .map(row => toEvent(row));
    }

    /** Sends a finished event again, from scratch. */
    retry(eventId: number): WebhookEventRow | null {
        const event = this.#db
            .query<EventRow, [number]>('SELECT * FROM webhook_events WHERE id = ?')
            .get(eventId);
        if (!event) return null;
        if (event.status === 'pending') {
            throw new WebhookRequestError('This event is still being sent', 409);
        }
        if (this.#row(event.endpoint_id)?.enabled !== 1) {
            throw new WebhookRequestError('Turn the endpoint on first', 409);
        }
        const row = this.#db
            .query<EventRow, [number, number]>(
                `UPDATE webhook_events SET status = 'pending', attempts = 0, due_at = ?, last_status = NULL,
                    last_error = NULL, finished_at = NULL WHERE id = ? RETURNING *`
            )
            .get(this.#now(), eventId);
        return row ? toEvent(row) : null;
    }

    async #checkUrl(url: string, kind: WebhookKind): Promise<void> {
        if (kind === 'discord' && !isDiscordWebhookUrl(url)) {
            throw new WebhookUrlError(
                'Discord webhook URLs look like https://discord.com/api/webhooks/<id>/<token>'
            );
        }
        await checkWebhookUrl(url, {
            allowPrivate: this.#opts.allowPrivate,
            resolve: this.#opts.resolve
        });
    }

    #row(id: number): EndpointRow | null {
        return this.#db
            .query<EndpointRow, [number]>('SELECT * FROM webhook_endpoints WHERE id = ?')
            .get(id);
    }

    #toEndpoint(row: EndpointRow): WebhookEndpoint {
        const since = this.#now() - KEEP_FINISHED_MS;
        const counts = { pending: 0, delivered: 0, skipped: 0, failed: 0 };
        const rows = this.#db
            .query<{ status: keyof typeof counts; n: number }, [number, number]>(
                `SELECT status, COUNT(*) AS n FROM webhook_events
                 WHERE endpoint_id = ? AND (status = 'pending' OR finished_at >= ?) GROUP BY status`
            )
            .all(row.id, since);
        for (const r of rows) counts[r.status] = r.n;
        const last = this.#db
            .query<
                {
                    status: WebhookLastEvent['status'];
                    finished_at: number;
                    last_status: number | null;
                    last_error: string | null;
                },
                [number]
            >(
                `SELECT status, finished_at, last_status, last_error FROM webhook_events
                 WHERE endpoint_id = ? AND finished_at IS NOT NULL AND status != 'skipped'
                 ORDER BY finished_at DESC, id DESC LIMIT 1`
            )
            .get(row.id);
        return {
            id: row.id,
            kind: row.kind,
            url: row.kind === 'discord' ? maskDiscordUrl(row.url) : row.url,
            description: row.description,
            enabled: row.enabled === 1,
            tags: JSON.parse(row.tags) as string[],
            skip: JSON.parse(row.skip) as WebhookSkipCategory[],
            includeIp: row.include_ip === 1,
            disabledReason: row.disabled_reason,
            failingSince: row.failing_since,
            counts,
            lastEvent: last
                ? {
                      status: last.status,
                      at: last.finished_at,
                      httpStatus: last.last_status,
                      error: last.last_error
                  }
                : null,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

function toEvent(row: EventRow): WebhookEventRow {
    return {
        id: row.id,
        type: row.type,
        clickId: row.click_id,
        eventId: row.event_id,
        status: row.status,
        attempts: row.attempts,
        httpStatus: row.last_status,
        error: row.last_error,
        createdAt: row.created_at,
        dueAt: row.due_at,
        finishedAt: row.finished_at
    };
}
