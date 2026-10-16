import type { Database } from 'bun:sqlite';

import type {
    ClickHistoryResponse,
    ClickHistoryRow,
    Dimension,
    StatsQuery,
    SummaryResponse,
    TimeseriesResponse,
    TopResponse,
    TopRow
} from '../shared/types.ts';

type Param = string | number;

const COLUMNS = {
    country: 'c.country',
    region: 'c.region',
    city: 'c.city',
    referrer: 'c.referrer_host',
    source: 'c.source',
    os: 'c.os',
    browser: 'c.browser',
    device: 'c.device',
    utm_source: 'c.utm_source',
    utm_medium: 'c.utm_medium',
    utm_campaign: 'c.utm_campaign',
    utm_term: 'c.utm_term',
    utm_content: 'c.utm_content',
    ip: 'c.ip'
} as const satisfies Partial<Record<Dimension, string>>;

type ColumnDimension = keyof typeof COLUMNS;

const PARAM_KEY_RE = /^[\w.~-]{1,64}$/;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export class BadQueryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BadQueryError';
    }
}

function isColumnDimension(dim: string): dim is ColumnDimension {
    return Object.hasOwn(COLUMNS, dim);
}

function paramPath(key: string): string {
    if (!PARAM_KEY_RE.test(key)) throw new BadQueryError(`Invalid query parameter name: ${key}`);
    return `$."${key}"`;
}

interface Condition {
    sql: string;
    params: Param[];
}

/** One `dim:value` filter as SQL. An empty value matches clicks without that field. */
export function filterCondition(filter: string): { group: string; condition: Condition } {
    const colon = filter.indexOf(':');
    if (colon === -1) throw new BadQueryError(`Invalid filter: ${filter}`);
    const dim = filter.slice(0, colon);
    const value = filter.slice(colon + 1);

    if (dim === 'link') {
        const id = Number(value);
        if (!Number.isInteger(id)) throw new BadQueryError(`Invalid link id: ${value}`);
        return { group: dim, condition: { sql: 'c.link_id = ?', params: [id] } };
    }
    if (dim === 'qr') {
        return {
            group: dim,
            condition: { sql: 'c.via_qr = ?', params: [value === 'QR' ? 1 : 0] }
        };
    }
    if (dim === 'param') {
        const eq = value.indexOf('=');
        const key = eq === -1 ? value : value.slice(0, eq);
        const path = paramPath(key);
        return {
            group: `param:${key}`,
            condition:
                eq === -1
                    ? { sql: 'json_extract(c.query, ?) IS NOT NULL', params: [path] }
                    : { sql: 'json_extract(c.query, ?) = ?', params: [path, value.slice(eq + 1)] }
        };
    }
    if (isColumnDimension(dim)) {
        const column = COLUMNS[dim];
        return {
            group: dim,
            condition:
                value === ''
                    ? { sql: `${column} IS NULL`, params: [] }
                    : { sql: `${column} = ?`, params: [value] }
        };
    }
    throw new BadQueryError(`Unknown filter dimension: ${dim}`);
}

/** WHERE clause for a query over [from, to). Filters on the same dimension are OR-ed. */
export function whereClause(query: StatsQuery, from = query.from, to = query.to): Condition {
    const parts: string[] = ['c.ts >= ?', 'c.ts < ?'];
    const params: Param[] = [from, to];
    if (query.link !== undefined) {
        parts.push('c.link_id = ?');
        params.push(query.link);
    }
    if (!query.bots) parts.push('c.is_bot = 0');

    const groups = new Map<string, Condition[]>();
    for (const filter of query.filters) {
        const { group, condition } = filterCondition(filter);
        const list = groups.get(group);
        if (list) list.push(condition);
        else groups.set(group, [condition]);
    }
    for (const conditions of groups.values()) {
        parts.push(`(${conditions.map(c => c.sql).join(' OR ')})`);
        params.push(...conditions.flatMap(c => c.params));
    }
    return { sql: parts.join(' AND '), params };
}

export class Stats {
    readonly #db: Database;

    constructor(db: Database) {
        this.#db = db;
    }

    summary(query: StatsQuery): SummaryResponse {
        const span = query.to - query.from;
        return {
            ...this.#totals(query, query.from, query.to),
            previous: this.#totals(query, query.from - span, query.from)
        };
    }

    timeseries(query: StatsQuery): TimeseriesResponse {
        const interval = query.to - query.from <= 3 * DAY ? 'hour' : 'day';
        const bucket = interval === 'hour' ? HOUR : DAY;
        const offset = query.tz * 60_000;
        const where = whereClause(query);
        const rows = this.#db
            .query<{ b: number; clicks: number; visitors: number }, Param[]>(
                `SELECT (c.ts + ?) / ${bucket} AS b, COUNT(*) AS clicks,
                        COUNT(DISTINCT c.visitor_hash) AS visitors
                 FROM clicks c WHERE ${where.sql} GROUP BY b`
            )
            .all(offset, ...where.params);
        const byBucket = new Map(rows.map(r => [r.b, r]));

        const first = Math.floor((query.from + offset) / bucket);
        const last = Math.floor((query.to - 1 + offset) / bucket);
        const points: TimeseriesResponse['points'] = [];
        for (let b = first; b <= last; b++) {
            const row = byBucket.get(b);
            points.push({
                t: b * bucket - offset,
                clicks: row?.clicks ?? 0,
                visitors: row?.visitors ?? 0
            });
        }
        return { interval, points };
    }

    top(query: StatsQuery, dim: string, limit = 10): TopResponse {
        const where = whereClause(query);
        const lim = Math.min(Math.max(limit, 1), 100);
        const agg = 'COUNT(*) AS clicks, COUNT(DISTINCT c.visitor_hash) AS visitors';
        let rows: {
            value: string | number | null;
            label?: string | null;
            clicks: number;
            visitors: number;
        }[];

        if (dim === 'link') {
            rows = this.#db
                .query<{ value: number; label: string; clicks: number; visitors: number }, Param[]>(
                    `SELECT c.link_id AS value, CASE l.slug WHEN '' THEN '/' ELSE l.slug END AS label, ${agg}
                     FROM clicks c JOIN links l ON l.id = c.link_id
                     WHERE ${where.sql} GROUP BY c.link_id ORDER BY clicks DESC, label LIMIT ?`
                )
                .all(...where.params, lim);
        } else if (dim === 'qr') {
            rows = this.#db
                .query<{ value: string; clicks: number; visitors: number }, Param[]>(
                    `SELECT CASE c.via_qr WHEN 1 THEN 'QR' ELSE 'Link' END AS value, ${agg}
                     FROM clicks c WHERE ${where.sql} GROUP BY value ORDER BY clicks DESC`
                )
                .all(...where.params);
        } else if (dim === 'param') {
            rows = this.#db
                .query<{ value: string; clicks: number; visitors: number }, Param[]>(
                    `SELECT j.key AS value, ${agg}
                     FROM clicks c, json_each(c.query) j
                     WHERE c.query IS NOT NULL AND ${where.sql}
                     GROUP BY j.key ORDER BY clicks DESC, value IS NULL, value LIMIT ?`
                )
                .all(...where.params, lim);
        } else if (dim.startsWith('param:')) {
            const path = paramPath(dim.slice('param:'.length));
            rows = this.#db
                .query<{ value: string; clicks: number; visitors: number }, Param[]>(
                    `SELECT json_extract(c.query, ?) AS value, ${agg}
                     FROM clicks c WHERE json_extract(c.query, ?) IS NOT NULL AND ${where.sql}
                     GROUP BY value ORDER BY clicks DESC, value IS NULL, value LIMIT ?`
                )
                .all(path, path, ...where.params, lim);
        } else if (isColumnDimension(dim)) {
            const column = COLUMNS[dim];
            rows = this.#db
                .query<{ value: string | null; clicks: number; visitors: number }, Param[]>(
                    `SELECT ${column} AS value, ${agg}
                     FROM clicks c WHERE ${where.sql}
                     GROUP BY value ORDER BY clicks DESC, value IS NULL, value LIMIT ?`
                )
                .all(...where.params, lim);
        } else {
            throw new BadQueryError(`Unknown dimension: ${dim}`);
        }

        return {
            dim,
            rows: rows.map((r): TopRow => ({
                value: r.value === null ? null : String(r.value),
                label: r.label ?? (r.value === null ? emptyLabel(dim) : String(r.value)),
                clicks: r.clicks,
                visitors: r.visitors
            }))
        };
    }

    /**
     * Individual clicks matching the query, newest first, `limit` per page.
     * Page with `offset` (page numbers, used by the dashboard), or keyset-page on
     * (ts, id) by passing the previous page's `next` as `before` (stable for scripts).
     * `total` is the number of clicks matching the query, ignoring `before`/`offset`.
     */
    history(
        query: StatsQuery,
        opts: { limit?: number; before?: string; offset?: number } = {}
    ): ClickHistoryResponse {
        const where = whereClause(query);
        const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 10_000);
        const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
        const total =
            this.#db
                .query<{ n: number }, Param[]>(
                    `SELECT COUNT(*) AS n FROM clicks c WHERE ${where.sql}`
                )
                .get(...where.params)?.n ?? 0;
        const params: Param[] = [...where.params];
        let sql = where.sql;
        if (opts.before !== undefined) {
            const cursor = /^(\d+)_(\d+)$/.exec(opts.before);
            if (!cursor)
                throw new BadQueryError('`before` must be a `next` value from a previous page');
            const ts = Number(cursor[1]);
            const id = Number(cursor[2]);
            sql += ' AND (c.ts < ? OR (c.ts = ? AND c.id < ?))';
            params.push(ts, ts, id);
        }
        type Flags = 'qr' | 'bot' | 'charging' | 'incognito' | 'adBlocker';
        const rows = this.#db
            .query<Omit<ClickHistoryRow, Flags> & Record<Flags, number | null>, Param[]>(
                `SELECT c.id, c.ts, c.link_id AS linkId, l.slug, c.ip, c.user_agent AS userAgent,
                        c.country, c.region, c.city, c.referrer, c.source, c.via_qr AS qr,
                        c.device, c.browser, c.os, c.is_bot AS bot, c.bot_name AS botName,
                        c.device_model AS deviceModel, c.language, c.timezone, c.hostname,
                        c.screen, c.orientation, c.battery, c.charging, c.connection, c.gpu,
                        c.incognito, c.ad_blocker AS adBlocker, c.latitude, c.longitude,
                        c.memory, c.platform, c.touch_points AS touchPoints
                 FROM clicks c LEFT JOIN links l ON l.id = c.link_id
                 WHERE ${sql} ORDER BY c.ts DESC, c.id DESC LIMIT ? OFFSET ?`
            )
            .all(...params, limit + 1, offset);
        const more = rows.length > limit;
        const page = more ? rows.slice(0, limit) : rows;
        const last = page.at(-1);
        return {
            clicks: page.map(r => ({
                ...r,
                qr: r.qr === 1,
                bot: r.bot === 1,
                charging: flag(r.charging),
                incognito: flag(r.incognito),
                adBlocker: flag(r.adBlocker)
            })),
            next: more && last ? `${last.ts}_${last.id}` : null,
            total
        };
    }

    /** Raw clicks matching the query as CSV, newest first. */
    csv(query: StatsQuery, maxRows = 100_000): string {
        const where = whereClause(query);
        const header = [
            'time',
            'slug',
            'country',
            'region',
            'city',
            'referrer',
            'source',
            'qr',
            'device',
            'browser',
            'os',
            'bot',
            'utm_source',
            'utm_medium',
            'utm_campaign',
            'utm_term',
            'utm_content',
            'query',
            'ip',
            'user_agent',
            'hostname',
            'language',
            'timezone',
            'bot_name',
            'device_model',
            'screen',
            'orientation',
            'battery',
            'charging',
            'connection',
            'gpu',
            'incognito',
            'ad_blocker',
            'latitude',
            'longitude',
            'memory',
            'platform',
            'touch_points'
        ];
        const rows = this.#db
            .query<Record<string, string | number | null>, Param[]>(
                `SELECT c.ts, CASE l.slug WHEN '' THEN '/' ELSE l.slug END AS slug, c.country, c.region, c.city, c.referrer, c.source, c.via_qr,
                        c.device, c.browser, c.os, c.is_bot, c.utm_source, c.utm_medium,
                        c.utm_campaign, c.utm_term, c.utm_content, c.query, c.ip, c.user_agent,
                        c.hostname, c.language, c.timezone, c.bot_name, c.device_model, c.screen,
                        c.orientation, c.battery, c.charging, c.connection, c.gpu, c.incognito,
                        c.ad_blocker, c.latitude, c.longitude, c.memory, c.platform,
                        c.touch_points
                 FROM clicks c LEFT JOIN links l ON l.id = c.link_id
                 WHERE ${where.sql} ORDER BY c.ts DESC LIMIT ?`
            )
            .values(...where.params, maxRows);
        const lines = [header.join(',')];
        for (const row of rows) {
            const [ts, ...rest] = row;
            lines.push(
                [new Date(Number(ts)).toISOString(), ...rest].map(cell => csvCell(cell)).join(',')
            );
        }
        return `${lines.join('\n')}\n`;
    }

    #totals(query: StatsQuery, from: number, to: number) {
        const where = whereClause(query, from, to);
        const row = this.#db
            .query<{ clicks: number; visitors: number }, Param[]>(
                `SELECT COUNT(*) AS clicks, COUNT(DISTINCT c.visitor_hash) AS visitors
                 FROM clicks c WHERE ${where.sql}`
            )
            .get(...where.params);
        return { clicks: row?.clicks ?? 0, visitors: row?.visitors ?? 0 };
    }
}

function emptyLabel(dim: string): string {
    if (dim === 'referrer') return 'Direct / none';
    return '(none)';
}

function csvCell(
    value: string | number | bigint | boolean | null | undefined | Uint8Array
): string {
    if (value === null || value === undefined) return '';
    const text = value instanceof Uint8Array ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A nullable 0/1 column as a boolean, keeping null for "not reported". */
function flag(value: number | null): boolean | null {
    return value === null ? null : value === 1;
}
