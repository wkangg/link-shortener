import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

import { isPrivateIp } from '../shared/ip.ts';
import type { ReverseDns } from './clicks.ts';

/** A valid IP address outside the loopback, private, link-local and CGNAT ranges. */
export function isPublicIp(ip: string): boolean {
    return isIP(ip) !== 0 && !isPrivateIp(ip);
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
