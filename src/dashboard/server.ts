import { pingDatabase } from '../db/client.ts';
import { type ApiDeps, apiRoutes } from './api.ts';
import app from './client/index.html';

export interface DashboardServerOptions extends ApiDeps {
    port: number;
    dev: boolean;
}

/** The dashboard listener: React SPA + JSON API + health check. */
export function startDashboardServer(opts: DashboardServerOptions) {
    return Bun.serve({
        port: opts.port,
        development: opts.dev ? { hmr: true, console: true } : false,
        routes: {
            // Container health check (Docker HEALTHCHECK, load balancers). Not behind auth.
            '/healthz': () =>
                pingDatabase(opts.db)
                    ? new Response('ok', { headers: { 'Cache-Control': 'no-store' } })
                    : new Response('db unavailable', { status: 503 }),

            ...apiRoutes(opts),

            // Everything else is the SPA (client-side routing).
            '/*': app
        },
        error(error) {
            console.error('[dashboard] unhandled error', error);
            return Response.json({ error: 'Internal error' }, { status: 500 });
        }
    });
}
