import type { Database } from 'bun:sqlite';

import { ClickBuffer, type ReverseDns } from './analytics/clicks.ts';
import { createReverseDns } from './analytics/hostname.ts';
import { Stats } from './analytics/stats.ts';
import { parseUserAgent } from './analytics/ua.ts';
import type { Config } from './config.ts';
import { type Authenticate, createAuthenticator } from './dashboard/auth.ts';
import { LinkRepo } from './dashboard/links.ts';
import { linkSchemas } from './dashboard/schemas.ts';
import { startDashboardServer } from './dashboard/server.ts';
import { LinkCache } from './redirect/cache.ts';
import { createLinkLookup } from './redirect/lookup.ts';
import { startRedirectServer } from './redirect/server.ts';

export interface AppOptions {
    config: Config;
    db: Database;
    version: string;
    /** Override auth (tests). */
    authenticate?: Authenticate;
    /** Click flush interval (tests use a manual flush). */
    flushIntervalMs?: number;
    /** Hostname lookups for click IPs; null turns them off (tests). */
    reverseDns?: ReverseDns | null;
}

/** Wires both servers to one database, one cache and one click buffer. */
export function startApp(opts: AppOptions) {
    const { config, db } = opts;
    const shortHost = new URL(config.shortOrigin).hostname;

    const cache = new LinkCache();
    const clicks = new ClickBuffer(db, {
        shortHost,
        salt: config.visitorSalt,
        intervalMs: opts.flushIntervalMs ?? 1000,
        reverseDns: opts.reverseDns === undefined ? createReverseDns() : opts.reverseDns
    });
    clicks.start();

    const short = startRedirectServer({
        port: config.shortPort,
        cache,
        lookup: createLinkLookup(db),
        clicks,
        isBot: ua => parseUserAgent(ua).isBot
    });

    const dash = startDashboardServer({
        port: config.dashPort,
        dev: !config.isProd,
        db,
        version: opts.version,
        links: new LinkRepo(db, cache),
        stats: new Stats(db),
        schemas: linkSchemas(shortHost),
        authenticate: opts.authenticate ?? createAuthenticator(config.cfAccess),
        dashOrigin: config.dashOrigin,
        shortOrigin: config.shortOrigin
    });

    return {
        short,
        dash,
        cache,
        clicks,
        async stop() {
            await Promise.all([short.stop(), dash.stop()]);
            clicks.stop();
        }
    };
}
