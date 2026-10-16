import type { Database } from 'bun:sqlite';

import { ClickBuffer, type ReverseDns } from './analytics/clicks.ts';
import { backfillDatacenterHostnames } from './analytics/datacenter.ts';
import { createReverseDns } from './analytics/hostname.ts';
import { type CheckIp, createAbuseIpdb, IpReputation } from './analytics/reputation.ts';
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
    /** IP reputation lookups; defaults to AbuseIPDB when a key is configured, null turns them off. */
    checkIp?: CheckIp | null;
}

/** Reputation backfill runs at startup and then this often. */
const BACKFILL_INTERVAL_MS = 6 * 3_600_000;

/** Wires both servers to one database, one cache and one click buffer. */
export function startApp(opts: AppOptions) {
    const { config, db } = opts;
    const shortHost = new URL(config.shortOrigin).hostname;

    const cache = new LinkCache();
    backfillDatacenterHostnames(db);

    const checkIp =
        opts.checkIp === undefined
            ? config.abuseIpdb && createAbuseIpdb(config.abuseIpdb.apiKey)
            : opts.checkIp;
    const reputation = checkIp
        ? new IpReputation(db, { check: checkIp, dailyLimit: config.abuseIpdb?.dailyLimit })
        : null;
    reputation?.backfill();
    const backfill = reputation
        ? setInterval(() => reputation.backfill(), BACKFILL_INTERVAL_MS)
        : null;
    backfill?.unref();

    const clicks = new ClickBuffer(db, {
        shortHost,
        salt: config.visitorSalt,
        intervalMs: opts.flushIntervalMs ?? 1000,
        reverseDns: opts.reverseDns === undefined ? createReverseDns() : opts.reverseDns,
        reputation
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
        stats: new Stats(db, { abuseMinScore: config.abuseMinScore }),
        schemas: linkSchemas(shortHost),
        authenticate: opts.authenticate ?? createAuthenticator(config.cfAccess),
        dashOrigin: config.dashOrigin,
        shortOrigin: config.shortOrigin,
        reputation: reputation !== null,
        abuseMinScore: config.abuseMinScore
    });

    return {
        short,
        dash,
        cache,
        clicks,
        reputation,
        async stop() {
            await Promise.all([short.stop(), dash.stop()]);
            if (backfill) clearInterval(backfill);
            reputation?.stop();
            clicks.stop();
        }
    };
}
