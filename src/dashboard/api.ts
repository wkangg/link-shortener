import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BunRequest, Server } from 'bun';
import { z } from 'zod/v4';

import { BadQueryError, Stats } from '../analytics/stats.ts';
import { databaseInfo, pingDatabase } from '../db/client.ts';
import type {
    AboutResponse,
    ApiError,
    ConfigResponse,
    HealthResponse,
    StatsQuery,
    WebhookSecretResponse
} from '../shared/types.ts';
import { type EndpointRepo, WebhookRequestError } from '../webhooks/endpoints.ts';
import { WebhookUrlError } from '../webhooks/url.ts';
import type { Authenticate } from './auth.ts';
import { type LinkRepo, type ListOptions, SlugTakenError } from './links.ts';
import { type LinkSchemas, webhookSchemas } from './schemas.ts';

export interface ApiDeps {
    db: Database;
    version: string;
    links: LinkRepo;
    webhooks: EndpointRepo;
    stats: Stats;
    schemas: LinkSchemas;
    authenticate: Authenticate;
    /** Browser requests that change data must come from this origin. */
    dashOrigin: string;
    shortOrigin: string;
    /** AbuseIPDB lookups are on. */
    reputation: boolean;
    abuseMinScore: number;
}

type Handler<Path extends string> = (
    req: BunRequest<Path>,
    server: Server<undefined>
) => Response | Promise<Response>;

const MAX_RANGE = 5 * 366 * 86_400_000;

/** An optional `1`/`true` query flag. */
const flag = z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform(v => v === '1' || v === 'true');

const statsQuerySchema = z.object({
    from: z.coerce.number().int(),
    to: z.coerce.number().int(),
    tz: z.coerce.number().int().min(-840).max(840).default(0),
    link: z.coerce.number().int().positive().optional(),
    bots: flag,
    dc: flag,
    scrapers: flag,
    /** On unless `0` / `false`. */
    vpn: z
        .enum(['0', '1', 'true', 'false'])
        .optional()
        .transform(v => v !== '0' && v !== 'false'),
    abusive: flag,
    q: z.string().optional()
});

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
    return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function error(message: string, status: number, issues?: ApiError['issues']): Response {
    const body: ApiError = issues ? { error: message, issues } : { error: message };
    return json(body, status);
}

/**
 * A compact, consistent copy of the database as a `.db` download. VACUUM INTO
 * writes a standalone file (no WAL) without blocking writers, but it runs on
 * this thread, so redirects wait while a large database is copied.
 */
async function exportDatabase(db: Database): Promise<Response> {
    const file = path.join(tmpdir(), `links-export-${randomUUID()}.db`);
    try {
        db.query('VACUUM INTO ?').run(file);
        const bytes = await Bun.file(file).bytes();
        const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
        return new Response(bytes, {
            headers: {
                'Content-Type': 'application/vnd.sqlite3',
                'Content-Disposition': `attachment; filename="links-${stamp}.db"`,
                'Cache-Control': 'no-store'
            }
        });
    } finally {
        rmSync(file, { force: true });
    }
}

function zodIssues(err: z.ZodError): NonNullable<ApiError['issues']> {
    return err.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }));
}

async function readJson(req: Request): Promise<unknown> {
    if (!req.headers.get('content-type')?.includes('application/json')) {
        throw new BadQueryError('Expected a JSON body (Content-Type: application/json)');
    }
    try {
        return await req.json();
    } catch {
        throw new BadQueryError('Malformed JSON body');
    }
}

function parseId(raw: string): number | null {
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
}

export function parseStatsQuery(url: URL): StatsQuery {
    const parsed = statsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new BadQueryError(z.prettifyError(parsed.error));
    const { from, to, tz, link, bots, dc, scrapers, vpn, abusive, q } = parsed.data;
    if (to <= from) throw new BadQueryError('`to` must be after `from`');
    if (to - from > MAX_RANGE) throw new BadQueryError('Date range is too long (max 5 years)');
    return {
        from,
        to,
        tz,
        bots,
        dc,
        scrapers,
        vpn,
        abusive,
        filters: url.searchParams.getAll('f'),
        ...(link !== undefined && { link }),
        ...(q && { q })
    };
}

function statsQueryOf(req: Request): StatsQuery {
    return parseStatsQuery(new URL(req.url));
}

function numberParam(params: URLSearchParams, name: string, fallback: number): number {
    const value = Number(params.get(name) ?? fallback);
    return Number.isFinite(value) ? value : fallback;
}

export function parseListQuery(req: Request): ListOptions {
    const p = new URL(req.url).searchParams;
    return {
        q: p.get('q') ?? undefined,
        tag: p.get('tag') ?? undefined,
        sort: p.get('sort') === 'clicks' ? 'clicks' : 'created',
        archived: p.get('archived') === '1',
        limit: numberParam(p, 'limit', 50),
        offset: numberParam(p, 'offset', 0),
        tz: numberParam(p, 'tz', 0)
    };
}

/** /api/* routes for Bun.serve's `routes` table. Everything except health needs auth. */
export function apiRoutes(deps: ApiDeps) {
    const { links, webhooks, stats, schemas } = deps;

    function guard<Path extends string>(handler: Handler<Path>): Handler<Path> {
        return async (req, server) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                const origin = req.headers.get('origin');
                if (origin && origin !== deps.dashOrigin) return error('Cross-origin request', 403);
            }
            const identity = await deps.authenticate(req, server.requestIP(req)?.address ?? '');
            if (!identity) return error('Not signed in through Cloudflare Access', 401);
            try {
                return await handler(req, server);
            } catch (error_) {
                if (error_ instanceof BadQueryError) return error(error_.message, 400);
                if (error_ instanceof SlugTakenError) return error(error_.message, 409);
                if (error_ instanceof WebhookUrlError) {
                    return error(error_.message, 400, [{ path: 'url', message: error_.message }]);
                }
                if (error_ instanceof WebhookRequestError) {
                    return error(error_.message, error_.status);
                }
                throw error_;
            }
        };
    }

    return {
        '/api/health': {
            GET: () => {
                const db = pingDatabase(deps.db);
                const body: HealthResponse = { ok: db, version: deps.version, db };
                return json(body, db ? 200 : 503);
            }
        },

        '/api/config': {
            GET: guard(() => {
                const body: ConfigResponse = {
                    shortOrigin: deps.shortOrigin,
                    dashOrigin: deps.dashOrigin,
                    version: deps.version,
                    reputation: deps.reputation,
                    abuseMinScore: deps.abuseMinScore
                };
                return json(body);
            })
        },

        '/api/about': {
            GET: guard(() => {
                const body: AboutResponse = {
                    version: deps.version,
                    bunVersion: Bun.version,
                    startedAt: Math.round(performance.timeOrigin),
                    database: databaseInfo(deps.db)
                };
                return json(body);
            })
        },

        '/api/export': {
            GET: guard(() => exportDatabase(deps.db))
        },

        '/api/links': {
            GET: guard(req => json(links.list(parseListQuery(req)))),
            POST: guard(async req => {
                const parsed = schemas.create.safeParse(await readJson(req));
                if (!parsed.success) return error('Invalid link', 400, zodIssues(parsed.error));
                return json(links.create(parsed.data), 201);
            })
        },

        '/api/links/:id': {
            GET: guard<'/api/links/:id'>(req => {
                const id = parseId(req.params.id);
                const link = id === null ? null : links.get(id);
                return link ? json(link) : error('Link not found', 404);
            }),
            PATCH: guard<'/api/links/:id'>(async req => {
                const id = parseId(req.params.id);
                if (id === null) return error('Link not found', 404);
                const parsed = schemas.update.safeParse(await readJson(req));
                if (!parsed.success) return error('Invalid link', 400, zodIssues(parsed.error));
                const link = links.update(id, parsed.data);
                return link ? json(link) : error('Link not found', 404);
            }),
            DELETE: guard<'/api/links/:id'>(req => {
                const id = parseId(req.params.id);
                return id !== null && links.delete(id)
                    ? new Response(null, { status: 204 })
                    : error('Link not found', 404);
            })
        },

        '/api/tags': {
            GET: guard(() => json(links.allTags()))
        },

        '/api/stats/summary': {
            GET: guard(req => json(stats.summary(statsQueryOf(req))))
        },

        '/api/stats/timeseries': {
            GET: guard(req => json(stats.timeseries(statsQueryOf(req))))
        },

        '/api/stats/top': {
            GET: guard(req => {
                const url = new URL(req.url);
                const dim = url.searchParams.get('dim') ?? '';
                const limit = Number(url.searchParams.get('limit') ?? 10) || 10;
                return json(stats.top(parseStatsQuery(url), dim, limit));
            })
        },

        '/api/stats/suggest': {
            GET: guard(req => {
                const url = new URL(req.url);
                const p = url.searchParams;
                return json(
                    stats.suggest(parseStatsQuery(url), p.get('field') ?? '', p.get('text') ?? '')
                );
            })
        },

        '/api/stats/clicks': {
            GET: guard(req => {
                const url = new URL(req.url);
                const p = url.searchParams;
                const before = p.get('before') ?? undefined;
                return json(
                    stats.history(parseStatsQuery(url), {
                        limit: numberParam(p, 'limit', 50),
                        offset: numberParam(p, 'offset', 0),
                        ...(before !== undefined && { before })
                    })
                );
            })
        },

        '/api/export.csv': {
            GET: guard(req => {
                const body = stats.csv(statsQueryOf(req));
                const date = new Date().toISOString().slice(0, 10);
                return new Response(body, {
                    headers: {
                        'Content-Type': 'text/csv; charset=utf-8',
                        'Content-Disposition': `attachment; filename="clicks-${date}.csv"`,
                        'Cache-Control': 'no-store'
                    }
                });
            })
        },

        '/api/webhooks': {
            GET: guard(() => json(webhooks.list())),
            POST: guard(async req => {
                const parsed = webhookSchemas.create.safeParse(await readJson(req));
                if (!parsed.success) return error('Invalid webhook', 400, zodIssues(parsed.error));
                return json(await webhooks.create(parsed.data), 201);
            })
        },

        '/api/webhooks/:id': {
            GET: guard<'/api/webhooks/:id'>(req => {
                const id = parseId(req.params.id);
                const endpoint = id === null ? null : webhooks.get(id);
                return endpoint ? json(endpoint) : error('Webhook not found', 404);
            }),
            PATCH: guard<'/api/webhooks/:id'>(async req => {
                const id = parseId(req.params.id);
                if (id === null) return error('Webhook not found', 404);
                const parsed = webhookSchemas.update.safeParse(await readJson(req));
                if (!parsed.success) return error('Invalid webhook', 400, zodIssues(parsed.error));
                const endpoint = await webhooks.update(id, parsed.data);
                return endpoint ? json(endpoint) : error('Webhook not found', 404);
            }),
            DELETE: guard<'/api/webhooks/:id'>(req => {
                const id = parseId(req.params.id);
                return id !== null && webhooks.delete(id)
                    ? new Response(null, { status: 204 })
                    : error('Webhook not found', 404);
            })
        },

        '/api/webhooks/:id/links/:linkId': {
            PUT: guard<'/api/webhooks/:id/links/:linkId'>(req => {
                const id = parseId(req.params.id);
                const linkId = parseId(req.params.linkId);
                const endpoint =
                    id === null || linkId === null ? null : webhooks.setLink(id, linkId, true);
                return endpoint ? json(endpoint) : error('Webhook not found', 404);
            }),
            DELETE: guard<'/api/webhooks/:id/links/:linkId'>(req => {
                const id = parseId(req.params.id);
                const linkId = parseId(req.params.linkId);
                const endpoint =
                    id === null || linkId === null ? null : webhooks.setLink(id, linkId, false);
                return endpoint ? json(endpoint) : error('Webhook not found', 404);
            })
        },

        '/api/webhooks/:id/secret': {
            POST: guard<'/api/webhooks/:id/secret'>(req => {
                const id = parseId(req.params.id);
                const secret = id === null ? null : webhooks.rotateSecret(id);
                if (secret === null) return error('Webhook not found', 404);
                const body: WebhookSecretResponse = { secret };
                return json(body);
            })
        },

        '/api/webhooks/:id/test': {
            POST: guard<'/api/webhooks/:id/test'>(req => {
                const id = parseId(req.params.id);
                const event = id === null ? null : webhooks.sendTest(id);
                return event ? json(event, 202) : error('Webhook not found', 404);
            })
        },

        '/api/webhooks/:id/events': {
            GET: guard<'/api/webhooks/:id/events'>(req => {
                const id = parseId(req.params.id);
                const limit = numberParam(new URL(req.url).searchParams, 'limit', 50);
                const events = id === null ? null : webhooks.events(id, limit);
                return events ? json(events) : error('Webhook not found', 404);
            })
        },

        '/api/webhook-events/:id/retry': {
            POST: guard<'/api/webhook-events/:id/retry'>(req => {
                const id = parseId(req.params.id);
                const event = id === null ? null : webhooks.retry(id);
                return event ? json(event) : error('Event not found', 404);
            })
        },

        '/api/*': () => error('Not found', 404)
    } as const;
}
