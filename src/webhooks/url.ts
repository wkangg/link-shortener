// Webhook URLs are fetched by the server, so they must not reach the server's own
// network: loopback, private, link-local and CGNAT addresses are refused.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { isPrivateIp } from '../shared/ip.ts';

/** Every address a hostname resolves to. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

export const resolveHost: ResolveHost = async hostname => {
    const addresses = await lookup(hostname, { all: true });
    return addresses.map(a => a.address);
};

export class WebhookUrlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WebhookUrlError';
    }
}

/** Throws a WebhookUrlError unless `raw` is an http(s) URL without credentials. */
export function parseWebhookUrl(raw: string): URL {
    if (!URL.canParse(raw)) throw new WebhookUrlError('Enter a full http(s) URL');
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new WebhookUrlError('Webhook URLs must use http or https');
    }
    if (url.username || url.password) {
        throw new WebhookUrlError('Webhook URLs cannot contain a username or password');
    }
    return url;
}

/**
 * Where to send a checked URL. A hostname is pinned to the address that was
 * checked, so a second DNS lookup can't point the request somewhere else.
 */
export interface WebhookTarget {
    url: string;
    /** The Host header and TLS server name for a pinned hostname. */
    host?: string;
    serverName?: string;
}

/**
 * Throws a WebhookUrlError if the URL is malformed or, unless `allowPrivate`,
 * resolves to an address on a private network.
 */
export async function checkWebhookUrl(
    raw: string,
    opts: { allowPrivate: boolean; resolve?: ResolveHost }
): Promise<WebhookTarget> {
    const url = parseWebhookUrl(raw);
    if (opts.allowPrivate) return { url: url.href };
    // IPv6 literals keep their brackets in `hostname`.
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    // An IP address is its own answer; only names are resolved.
    if (isIP(host)) {
        if (isPrivateIp(host)) {
            throw new WebhookUrlError(`${host} points at a private network address`);
        }
        return { url: url.href };
    }
    let addresses: string[];
    try {
        addresses = await (opts.resolve ?? resolveHost)(host);
    } catch {
        throw new WebhookUrlError(`Could not resolve ${host}`);
    }
    const [address] = addresses;
    if (address === undefined) throw new WebhookUrlError(`Could not resolve ${host}`);
    if (addresses.some(a => isPrivateIp(a))) {
        throw new WebhookUrlError(`${host} points at a private network address`);
    }
    const pinned = new URL(url);
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
    return { url: pinned.href, host: url.host, serverName: host };
}
