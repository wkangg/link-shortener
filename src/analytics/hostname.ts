import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { ReverseDns } from './clicks.ts';

// Loopback, private, link-local and CGNAT ranges have no public PTR record worth asking for.
const PRIVATE_RE =
    /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)|^(?:::1?|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

/** A valid IP address outside the loopback, private, link-local and CGNAT ranges. */
export function isPublicIp(ip: string): boolean {
    return isIP(ip) !== 0 && !PRIVATE_RE.test(ip);
}

/** PTR lookups with a short timeout, one try. Private addresses are skipped. */
export function createReverseDns(timeoutMs = 2000): ReverseDns {
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    return async ip => {
        if (!isPublicIp(ip)) return null;
        const names = await resolver.reverse(ip);
        return names[0]?.slice(0, 253) ?? null;
    };
}
