import type { Database } from 'bun:sqlite';

import type { BunRequest } from 'bun';
import { z } from 'zod/v4';

import { BadQueryError, Stats } from '../analytics/stats.ts';
import { pingDatabase } from '../db/client.ts';
import type { ApiError, ConfigResponse, HealthResponse, StatsQuery } from '../shared/types.ts';
import type { Authenticate } from './auth.ts';
import { type LinkRepo, type ListOptions, SlugTakenError } from './links.ts';
import type { LinkSchemas } from './schemas.ts';

export interface ApiDeps {
    db: Database;
    version: string;
    links: LinkRepo;
    stats: Stats;
    schemas: LinkSchemas;
    authenticate: Authenticate;
    /** Browser requests that change data must come from this origin. */
    dashOrigin: string;
    shortOrigin: string;
}

type Handler<Path extends string> = (req: BunRequest<Path>) => Response | Promise<Response>;

const MAX_RANGE = 5 * 366 * 86_400_000;

const statsQuerySchema = z.object({
    from: z.coerce.number().int(),
    to: z.coerce.number().int(),
    tz: z.coerce.number().int().min(-840).max(840).default(0),
    link: z.coerce.number().int().positive().optional(),
    bots: z
        .enum(['0', '1', 'true', 'false'])
        .optional()
        .transform(v => v === '1' || v === 'true')
});

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
    return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function error(message: string, status: number, issues?: ApiError['issues']): Response {
    const body: ApiError = issues ? { error: message, issues } : { error: message };
    return json(body, status);
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
    const { from, to, tz, link, bots } = parsed.data;
    if (to <= from) throw new BadQueryError('`to` must be after `from`');
    if (to - from > MAX_RANGE) throw new BadQueryError('Date range is too long (max 5 years)');
    return {
        from,
        to,
        tz,
        bots,
        filters: url.searchParams.getAll('f'),
        ...(link !== undefined && { link })
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
    const { links, stats, schemas } = deps;

    function guard<Path extends string>(handler: Handler<Path>): Handler<Path> {
        return async req => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                const origin = req.headers.get('origin');
                if (origin && origin !== deps.dashOrigin) return error('Cross-origin request', 403);
            }
            const identity = await deps.authenticate(req);
            if (!identity) return error('Not signed in through Cloudflare Access', 401);
            try {
                return await handler(req);
            } catch (error_) {
                if (error_ instanceof BadQueryError) return error(error_.message, 400);
                if (error_ instanceof SlugTakenError) return error(error_.message, 409);
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
                    version: deps.version
                };
                return json(body);
            })
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

        '/api/stats/clicks': {
            GET: guard(req => {
                const url = new URL(req.url);
                const p = url.searchParams;
                const before = p.get('before') ?? undefined;
                return json(
                    stats.history(parseStatsQuery(url), {
                        limit: numberParam(p, 'limit', 50),
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

        '/api/*': () => error('Not found', 404)
    } as const;
}
