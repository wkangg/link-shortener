import { createRedirectHandler, type RedirectHandlerOptions } from './handler.ts';

export interface RedirectServerOptions extends RedirectHandlerOptions {
    port: number;
}

/** The short-link listener. A bare fetch handler: no router, no middleware. */
export function startRedirectServer(opts: RedirectServerOptions) {
    const handler = createRedirectHandler(opts);

    return Bun.serve({
        port: opts.port,
        fetch: handler,
        error(error) {
            console.error('[redirect] unhandled error', error);
            return new Response('Internal error', { status: 500 });
        }
    });
}
