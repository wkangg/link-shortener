import { createRedirectHandler, type RedirectHandlerOptions } from './handler.ts';
import { MAX_SIGNALS_BODY } from './interstitial.ts';

export interface RedirectServerOptions extends RedirectHandlerOptions {
    port: number;
}

/** The short-link listener. A bare fetch handler: no router, no middleware. */
export function startRedirectServer(opts: RedirectServerOptions) {
    const handler = createRedirectHandler(opts);

    return Bun.serve({
        port: opts.port,
        // The only body this server accepts is the device-signals report.
        maxRequestBodySize: MAX_SIGNALS_BODY,
        fetch: handler,
        error(error) {
            console.error('[redirect] unhandled error', error);
            return new Response('Internal error', { status: 500 });
        }
    });
}
