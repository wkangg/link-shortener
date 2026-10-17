import type { CheckIp } from '../src/analytics/reputation.ts';
import { startApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Identity } from '../src/dashboard/auth.ts';
import { openDatabase } from '../src/db/client.ts';
import type { WebhookFetch } from '../src/webhooks/deliverer.ts';

export const DASH = 'https://dash.example';

/**
 * Both servers on random ports, an in-memory database, and switchable auth.
 * IP reputation is off unless a `checkIp` stub is passed. Webhooks go to
 * `webhookFetch` (204 by default) and only on `app.webhooks.tick()`.
 */
export function testApp(opts: { checkIp?: CheckIp; webhookFetch?: WebhookFetch } = {}) {
    const db = openDatabase(':memory:');
    const config = loadConfig({
        SHORT_PORT: '0',
        DASH_PORT: '0',
        SHORT_ORIGIN: 'https://s.example',
        DASH_ORIGIN: DASH,
        VISITOR_SALT: 'test-salt-test-salt'
    });
    const auth: { identity: Identity | null } = { identity: { subject: 'me@example.com' } };
    const app = startApp({
        config,
        db,
        version: 'test',
        authenticate: () => Promise.resolve(auth.identity),
        flushIntervalMs: 60_000,
        reverseDns: null,
        checkIp: opts.checkIp ?? null,
        fetchText: null,
        webhookFetch:
            opts.webhookFetch ?? (() => Promise.resolve(new Response(null, { status: 204 }))),
        webhookIntervalMs: 3_600_000
    });

    const api = (path: string, init: RequestInit = {}) =>
        fetch(new URL(path, app.dash.url), {
            ...init,
            headers: {
                ...(init.body !== undefined && {
                    'Content-Type': 'application/json',
                    Origin: DASH
                }),
                ...init.headers
            }
        });
    // Browsers always send Accept-Language; a click without it counts as a scraper.
    const click = (path: string, headers: Record<string, string> = {}) =>
        fetch(new URL(path, app.short.url), {
            redirect: 'manual',
            headers: { 'accept-language': 'en-US', ...headers }
        });

    /** Status code of a dashboard request. */
    const status = async (path: string, init?: RequestInit) => {
        const res = await api(path, init);
        return res.status;
    };
    /** Parsed JSON body of a dashboard GET. */
    const get = async <T>(path: string): Promise<T> => {
        const res = await api(path);
        return (await res.json()) as T;
    };

    return {
        app,
        status,
        get,
        db,
        auth,
        api,
        click,
        async close() {
            await app.stop();
            db.close();
        }
    };
}
