import type { Database } from 'bun:sqlite';

import { BadQueryError } from '../analytics/errors.ts';
import { likePattern, tokenize } from '../analytics/search.ts';
import { randomSlug, ROOT_SLUG } from '../shared/slug.ts';
import type {
    Link,
    LinkListResponse,
    LinkWebhookRef,
    LinkWithStats,
    RedirectType
} from '../shared/types.ts';
import type { CreateLinkInput, UpdateLinkInput } from './schemas.ts';

interface LinkRow {
    id: number;
    slug: string;
    url: string;
    title: string | null;
    redirect_type: number;
    expires_at: number | null;
    archived: number;
    track_device: number;
    created_at: number;
    updated_at: number;
}

export class SlugTakenError extends Error {
    constructor(slug: string) {
        super(
            slug === ROOT_SLUG
                ? 'There is already a root link. Edit or delete that one instead.'
                : `The slug "${slug}" is already taken`
        );
        this.name = 'SlugTakenError';
    }
}

export interface ListOptions {
    q?: string;
    tag?: string;
    sort?: 'created' | 'clicks';
    archived?: boolean;
    limit?: number;
    offset?: number;
    /** Minutes to add to UTC for local days (sparklines). */
    tz?: number;
}

const DAY = 86_400_000;
const SPARK_DAYS = 7;

/** Anything holding cached slugs (the redirect cache). */
export interface SlugInvalidator {
    invalidate(slug: string): void;
}

export class LinkRepo {
    readonly #db: Database;
    readonly #cache: SlugInvalidator;
    readonly #now: () => number;

    constructor(db: Database, cache: SlugInvalidator, now: () => number = Date.now) {
        this.#db = db;
        this.#cache = cache;
        this.#now = now;
    }

    get(id: number): Link | null {
        const row = this.#db.query<LinkRow, [number]>('SELECT * FROM links WHERE id = ?').get(id);
        return row ? toLink(row, this.#tagsFor([row.id]).get(row.id) ?? []) : null;
    }

    getBySlug(slug: string): Link | null {
        const row = this.#db
            .query<LinkRow, [string]>('SELECT * FROM links WHERE slug = ? COLLATE NOCASE')
            .get(slug);
        return row ? toLink(row, this.#tagsFor([row.id]).get(row.id) ?? []) : null;
    }

    list(opts: ListOptions = {}): LinkListResponse {
        const where: string[] = ['l.archived = ?'];
        const params: (string | number)[] = [opts.archived ? 1 : 0];
        if (opts.q) {
            const search = compileLinkSearch(opts.q);
            where.push(...search.where);
            params.push(...search.params);
        }
        if (opts.tag) {
            where.push('EXISTS (SELECT 1 FROM link_tags t WHERE t.link_id = l.id AND t.tag = ?)');
            params.push(opts.tag);
        }
        const whereSql = where.join(' AND ');
        const order = opts.sort === 'clicks' ? 'clicks DESC, l.id DESC' : 'l.id DESC';
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
        const offset = Math.max(opts.offset ?? 0, 0);

        const rows = this.#db
            .query<LinkRow & { clicks: number; visitors: number }, (string | number)[]>(
                `SELECT l.*,
                    (SELECT COUNT(*) FROM clicks c WHERE c.link_id = l.id AND c.is_bot = 0) AS clicks,
                    (SELECT COUNT(DISTINCT c.visitor_hash) FROM clicks c
                     WHERE c.link_id = l.id AND c.is_bot = 0) AS visitors
                 FROM links l WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`
            )
            .all(...params, limit, offset);
        const total =
            this.#db
                .query<{ n: number }, (string | number)[]>(
                    `SELECT COUNT(*) AS n FROM links l WHERE ${whereSql}`
                )
                .get(...params)?.n ?? 0;

        const ids = rows.map(r => r.id);
        const tags = this.#tagsFor(ids);
        const sparks = this.#sparklines(ids, opts.tz ?? 0);
        const webhooks = this.#webhooksFor(ids);
        const links: LinkWithStats[] = rows.map(row => ({
            ...toLink(row, tags.get(row.id) ?? []),
            clicks: row.clicks,
            visitors: row.visitors,
            spark: sparks.get(row.id) ?? Array.from({ length: SPARK_DAYS }, () => 0),
            webhooks: webhooks.get(row.id) ?? []
        }));
        return { links, total };
    }

    allTags(): { tag: string; count: number }[] {
        return this.#db
            .query<{ tag: string; count: number }, []>(
                'SELECT tag, COUNT(*) AS count FROM link_tags GROUP BY tag ORDER BY count DESC, tag'
            )
            .all();
    }

    create(input: CreateLinkInput): Link {
        const now = this.#now();
        const insert = this.#db.query<{ id: number }, (string | number | null)[]>(
            `INSERT INTO links (slug, url, title, redirect_type, expires_at, track_device, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        );
        const custom = input.slug ?? null;

        for (let attempt = 0; attempt < 8; attempt++) {
            const slug = custom ?? randomSlug();
            try {
                const id = this.#db.transaction(() => {
                    const row = insert.get(
                        slug,
                        input.url,
                        input.title ?? null,
                        input.redirectType ?? 302,
                        input.expiresAt ?? null,
                        input.trackDevice ? 1 : 0,
                        now,
                        now
                    );
                    if (!row) throw new Error('Insert returned no row');
                    this.#setTags(row.id, input.tags ?? []);
                    return row.id;
                })();
                this.#cache.invalidate(slug);
                const link = this.get(id);
                if (!link) throw new Error('Created link vanished');
                return link;
            } catch (error) {
                if (!isUniqueViolation(error)) throw error;
                if (custom !== null) throw new SlugTakenError(custom);
            }
        }
        throw new Error('Could not find a free random slug');
    }

    update(id: number, patch: UpdateLinkInput): Link | null {
        const existing = this.get(id);
        if (!existing) return null;

        const sets: string[] = [];
        const params: (string | number | null)[] = [];
        const column = (name: string, value: string | number | null) => {
            sets.push(`${name} = ?`);
            params.push(value);
        };
        if (patch.url !== undefined) column('url', patch.url);
        if (patch.slug !== undefined) column('slug', patch.slug);
        if (patch.title !== undefined) column('title', patch.title);
        if (patch.redirectType !== undefined) column('redirect_type', patch.redirectType);
        if (patch.expiresAt !== undefined) column('expires_at', patch.expiresAt);
        if (patch.archived !== undefined) column('archived', patch.archived ? 1 : 0);
        if (patch.trackDevice !== undefined) column('track_device', patch.trackDevice ? 1 : 0);
        column('updated_at', this.#now());

        try {
            this.#db.transaction(() => {
                this.#db
                    .query(`UPDATE links SET ${sets.join(', ')} WHERE id = ?`)
                    .run(...params, id);
                if (patch.tags !== undefined) this.#setTags(id, patch.tags);
            })();
        } catch (error) {
            if (isUniqueViolation(error) && patch.slug !== undefined) {
                throw new SlugTakenError(patch.slug);
            }
            throw error;
        }

        this.#cache.invalidate(existing.slug);
        if (patch.slug !== undefined) this.#cache.invalidate(patch.slug);
        return this.get(id);
    }

    /** Deletes the link and all of its clicks. */
    delete(id: number): boolean {
        const existing = this.get(id);
        if (!existing) return false;
        this.#db.transaction(() => {
            this.#db.query('DELETE FROM clicks WHERE link_id = ?').run(id);
            this.#db.query('DELETE FROM links WHERE id = ?').run(id);
        })();
        this.#cache.invalidate(existing.slug);
        return true;
    }

    #setTags(id: number, tags: string[]): void {
        this.#db.query('DELETE FROM link_tags WHERE link_id = ?').run(id);
        const insert = this.#db.query('INSERT INTO link_tags (link_id, tag) VALUES (?, ?)');
        for (const tag of tags) insert.run(id, tag);
    }

    #tagsFor(ids: number[]): Map<number, string[]> {
        const out = new Map<number, string[]>();
        if (ids.length === 0) return out;
        const rows = this.#db
            .query<{ link_id: number; tag: string }, number[]>(
                `SELECT link_id, tag FROM link_tags WHERE link_id IN (${placeholders(ids)}) ORDER BY tag`
            )
            .all(...ids);
        for (const row of rows) {
            const list = out.get(row.link_id);
            if (list) list.push(row.tag);
            else out.set(row.link_id, [row.tag]);
        }
        return out;
    }

    /** Webhooks chosen for each link, by link or by tag. */
    #webhooksFor(ids: number[]): Map<number, LinkWebhookRef[]> {
        const out = new Map<number, LinkWebhookRef[]>();
        if (ids.length === 0) return out;
        const rows = this.#db
            .query<
                {
                    link_id: number;
                    id: number;
                    kind: string;
                    url: string;
                    description: string | null;
                    enabled: number;
                },
                number[]
            >(
                `SELECT DISTINCT m.link_id, e.id, e.kind, e.url, e.description, e.enabled
                 FROM (
                     SELECT link_id, endpoint_id FROM webhook_endpoint_links
                     WHERE link_id IN (${placeholders(ids)})
                     UNION
                     SELECT t.link_id, e.id FROM link_tags t
                     JOIN webhook_endpoints e ON e.all_links = 0
                     JOIN json_each(e.tags) j ON j.value = t.tag
                     WHERE t.link_id IN (${placeholders(ids)})
                 ) m JOIN webhook_endpoints e ON e.id = m.endpoint_id
                 WHERE e.all_links = 0
                 ORDER BY m.link_id, e.id`
            )
            .all(...ids, ...ids);
        for (const row of rows) {
            const ref: LinkWebhookRef = {
                id: row.id,
                name: row.description ?? (row.kind === 'discord' ? 'Discord' : hostOf(row.url)),
                enabled: row.enabled === 1
            };
            const list = out.get(row.link_id);
            if (list) list.push(ref);
            else out.set(row.link_id, [ref]);
        }
        return out;
    }

    #sparklines(ids: number[], tz: number): Map<number, number[]> {
        const out = new Map<number, number[]>();
        if (ids.length === 0) return out;
        const offset = tz * 60_000;
        const today = Math.floor((this.#now() + offset) / DAY);
        const firstDay = today - SPARK_DAYS + 1;
        const rows = this.#db
            .query<{ link_id: number; d: number; n: number }, number[]>(
                `SELECT link_id, (ts + ?) / ${DAY} AS d, COUNT(*) AS n FROM clicks
                 WHERE link_id IN (${placeholders(ids)}) AND ts >= ? AND is_bot = 0
                 GROUP BY link_id, d`
            )
            .all(offset, ...ids, firstDay * DAY - offset);
        for (const row of rows) {
            let spark = out.get(row.link_id);
            if (!spark) {
                spark = Array.from({ length: SPARK_DAYS }, () => 0);
                out.set(row.link_id, spark);
            }
            const index = row.d - firstDay;
            if (index >= 0 && index < SPARK_DAYS) spark[index] = row.n;
        }
        return out;
    }
}

/**
 * Webhooks chosen for link `l`, directly or by tag. Webhooks for every link
 * don't count: they'd match every link.
 */
const CHOSEN_WEBHOOKS = `SELECT 1 FROM webhook_endpoints e WHERE e.all_links = 0 AND (
    EXISTS (SELECT 1 FROM webhook_endpoint_links el WHERE el.endpoint_id = e.id AND el.link_id = l.id)
    OR EXISTS (SELECT 1 FROM link_tags t JOIN json_each(e.tags) j ON j.value = t.tag
               WHERE t.link_id = l.id))`;

const LIKE = String.raw`LIKE ? ESCAPE '\'`;

/**
 * The links search: words match the slug, destination or title, and
 * `has:webhook`, `webhook:<name>` and `is:tracked` filter. Terms are AND-ed; a
 * leading `-` negates one; "quoted phrases" stay together.
 */
export function compileLinkSearch(q: string): { where: string[]; params: string[] } {
    const where: string[] = [];
    const params: string[] = [];
    for (const term of tokenize(q).slice(0, 32)) {
        const value = term.value.replace(/^=/, '');
        let sql: string;
        switch (term.field ?? '') {
            case 'has':
                if (!/^webhooks?$/i.test(value)) {
                    throw new BadQueryError(`Unknown has:${value}. Try has:webhook.`);
                }
                sql = `EXISTS (${CHOSEN_WEBHOOKS})`;
                break;
            case 'is':
                if (value.toLowerCase() !== 'tracked') {
                    throw new BadQueryError(`Unknown is:${value}. Try is:tracked.`);
                }
                sql = 'l.track_device = 1';
                break;
            case 'webhook': {
                // The name the dashboard shows: the description, "Discord", or the URL.
                sql = `EXISTS (${CHOSEN_WEBHOOKS} AND (e.description ${LIKE}
                    OR (e.kind = 'discord' AND 'Discord' ${LIKE})
                    OR (e.kind = 'standard' AND e.url ${LIKE})))`;
                const pattern = likePattern(value);
                params.push(pattern, pattern, pattern);
                break;
            }
            default: {
                // Plain words, and anything that isn't one of the fields above.
                const text = term.field ? `${term.field}:${term.value}` : value;
                sql = `(l.slug ${LIKE} OR l.url ${LIKE} OR l.title ${LIKE})`;
                const pattern = likePattern(text);
                params.push(pattern, pattern, pattern);
            }
        }
        where.push(term.negate ? `NOT ${sql}` : sql);
    }
    return { where, params };
}

function toLink(row: LinkRow, tags: string[]): Link {
    return {
        id: row.id,
        slug: row.slug,
        url: row.url,
        title: row.title,
        redirectType: row.redirect_type as RedirectType,
        expiresAt: row.expires_at,
        archived: row.archived === 1,
        trackDevice: row.track_device === 1,
        tags,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function hostOf(url: string): string {
    return URL.canParse(url) ? new URL(url).host : url;
}

function placeholders(values: unknown[]): string {
    return values.map(() => '?').join(', ');
}

function isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && /UNIQUE constraint failed: links\.slug/.test(error.message);
}
