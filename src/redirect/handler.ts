// HOT PATH. Keep this module synchronous and free of heavy imports.
// Allowed imports are enforced by test/boundaries.test.ts.
import { ROOT_SLUG, SLUG_RE } from '../shared/slug.ts';
import type { ClickSink } from '../shared/types.ts';
import type { LinkCache } from './cache.ts';
import { interstitialHtml, SIGNALS_PATH } from './interstitial.ts';
import type { LinkLookup } from './lookup.ts';

export interface RedirectHandlerOptions {
    cache: LinkCache;
    lookup: LinkLookup;
    clicks: ClickSink;
    /** Bots skip the device-signals page so link previews still see the redirect. */
    isBot?: (ua: string) => boolean;
    /** Injectable clock for tests. */
    now?: () => number;
}

/** Bun.serve's `server` argument, narrowed to what we use. */
export interface PeerInfo {
    requestIP(req: Request): { address: string } | null;
}

const NO_STORE = 'private, no-store';

/**
 * Splits an absolute request URL into path and query without allocating a URL
 * object. Request URLs from Bun.serve are always absolute (`http://host/path?q`).
 */
export function splitUrl(url: string): [path: string, query: string] {
    const start = url.indexOf('/', url.indexOf('//') + 2);
    if (start === -1) return ['/', ''];
    const q = url.indexOf('?', start);
    return q === -1 ? [url.slice(start), ''] : [url.slice(start, q), url.slice(q + 1)];
}

export function pathOf(url: string): string {
    return splitUrl(url)[0];
}

/**
 * Removes the `qr` flag from a query string. Returns the remaining query and
 * whether the flag was present.
 */
export function takeQrFlag(query: string): [rest: string, qr: boolean] {
    if (query === '') return ['', false];
    let qr = false;
    const kept: string[] = [];
    for (const part of query.split('&')) {
        if (part === 'qr' || part.startsWith('qr=')) qr = true;
        else if (part !== '') kept.push(part);
    }
    return [kept.join('&'), qr];
}

/** Merges the short URL's query params onto the destination (short URL wins). */
export function mergeQuery(destination: string, query: string): string {
    if (query === '') return destination;
    try {
        const url = new URL(destination);
        for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
        return url.href;
    } catch {
        return destination;
    }
}

export function createRedirectHandler(opts: RedirectHandlerOptions) {
    const { cache, lookup, clicks } = opts;
    const now = opts.now ?? Date.now;
    const isBot = opts.isBot ?? (() => false);

    return function handleRedirect(req: Request, server?: PeerInfo): Response | Promise<Response> {
        const isHead = req.method === 'HEAD';
        if (req.method === 'POST' && pathOf(req.url) === SIGNALS_PATH) {
            return receiveSignals(req, clicks, now());
        }
        if (req.method !== 'GET' && !isHead) {
            return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
        }

        const [path, rawQuery] = splitUrl(req.url);
        // `/` is the root link (empty slug): 404 until one is created in the dashboard.
        const slug = path.slice(1);
        if (slug !== ROOT_SLUG && !SLUG_RE.test(slug)) return notFound();

        const t = now();
        const key = slug.toLowerCase();
        let link = cache.get(key, t);
        if (link === undefined) {
            link = lookup(slug);
            cache.set(key, link, t);
        }
        if (!link) return notFound();
        if (link.expiresAt !== null && link.expiresAt <= t) return gone();

        const [query, qr] = takeQrFlag(rawQuery);
        const destination = mergeQuery(link.url, query);

        // HEAD is what link-preview bots and uptime checks send; don't count it.
        if (!isHead) {
            const h = req.headers;
            const ua = h.get('user-agent') ?? '';
            const token = link.track && !isBot(ua) ? crypto.randomUUID() : null;
            clicks.push({
                linkId: link.id,
                ts: t,
                url: link.url,
                ip: h.get('cf-connecting-ip') ?? server?.requestIP(req)?.address ?? '',
                ua,
                referrer: h.get('referer') ?? '',
                country: h.get('cf-ipcountry') ?? '',
                region: h.get('cf-region') ?? '',
                city: h.get('cf-ipcity') ?? '',
                continent: h.get('cf-ipcontinent') ?? '',
                regionCode: h.get('cf-region-code') ?? '',
                postalCode: h.get('cf-postal-code') ?? '',
                metroCode: h.get('cf-metro-code') ?? '',
                ray: h.get('cf-ray') ?? '',
                // Set by a Cloudflare Worker or Transform Rule; see migrations/0005.
                asn: h.get('x-asn') ?? '',
                asOrg: h.get('x-as-org') ?? '',
                qr,
                query,
                language: h.get('accept-language') ?? '',
                timezone: h.get('cf-timezone') ?? '',
                latitude: h.get('cf-iplatitude') ?? '',
                longitude: h.get('cf-iplongitude') ?? '',
                token
            });
            if (token) return interstitial(destination, token);
        }

        return redirect(destination, link.status);
    };
}

async function receiveSignals(req: Request, clicks: ClickSink, ts: number): Promise<Response> {
    // Bun.serve's maxRequestBodySize caps the body (413) before it's read.
    const body = await req.text();
    // The token is checked against the clicks table at flush time; just find it here.
    const token = /"t":"([\w-]{1,64})"/.exec(body)?.[1];
    if (token) clicks.pushSignals(token, body, ts);
    return new Response(null, { status: 204, headers: { 'Cache-Control': NO_STORE } });
}

function interstitial(destination: string, token: string): Response {
    return new Response(interstitialHtml(destination, token), {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': NO_STORE,
            'X-Robots-Tag': 'noindex',
            'Content-Security-Policy':
                "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; connect-src 'self'"
        }
    });
}

function redirect(location: string, status: number): Response {
    return new Response(null, {
        status,
        headers: { Location: location, 'Cache-Control': NO_STORE }
    });
}

function notFound(): Response {
    return text('Not found', 404);
}

function gone(): Response {
    return text('This link has expired', 410);
}

function text(body: string, status: number): Response {
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_STORE }
    });
}
