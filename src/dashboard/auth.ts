import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import { isPrivateIp } from '../shared/ip.ts';

export interface Identity {
    /** Email for a person; the service token's client ID for a machine. */
    subject: string;
}

/** `peerIp` is the address of the connection itself (not a forwarded header). */
export type Authenticate = (req: Request, peerIp?: string) => Promise<Identity | null>;

export interface AccessConfig {
    teamDomain: string;
    aud: string;
}

/**
 * Verifies the JWT that Cloudflare Access attaches to every request it lets
 * through. Keys are fetched from the team's JWKS endpoint and cached by `jose`.
 *
 * With no Access config (local development) only loopback and private-network
 * peers are allowed, so a deploy that forgot to set up Access isn't open to the
 * internet.
 */
export function createAuthenticator(
    config: AccessConfig | null,
    keys?: JWTVerifyGetKey
): Authenticate {
    if (!config) {
        return (_, peerIp) =>
            Promise.resolve(isPrivateIp(peerIp ?? '') ? { subject: 'local-dev' } : null);
    }

    const issuer = `https://${config.teamDomain}`;
    const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

    return async req => {
        const token = req.headers.get('cf-access-jwt-assertion') ?? cookie(req, 'CF_Authorization');
        if (!token) return null;
        try {
            const { payload } = await jwtVerify(token, jwks, {
                issuer,
                audience: config.aud,
                algorithms: ['RS256']
            });
            const subject =
                typeof payload.email === 'string'
                    ? payload.email
                    : typeof payload.common_name === 'string'
                      ? payload.common_name
                      : (payload.sub ?? 'unknown');
            return { subject };
        } catch {
            return null;
        }
    };
}

function cookie(req: Request, name: string): string | null {
    const header = req.headers.get('cookie');
    if (!header) return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}
