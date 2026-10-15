import { describe, expect, test } from 'bun:test';

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';

import { createAuthenticator } from '../src/dashboard/auth.ts';

const TEAM = 'me.cloudflareaccess.com';
const AUD = 'aud-tag';

async function setup() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const authenticate = createAuthenticator(
        { teamDomain: TEAM, aud: AUD },
        createLocalJWKSet({ keys: [jwk] })
    );
    const sign = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string } = {}) =>
        new SignJWT(claims)
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(opts.iss ?? `https://${TEAM}`)
            .setAudience(opts.aud ?? AUD)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);
    return { authenticate, sign };
}

const req = (headers: Record<string, string>) =>
    new Request('https://dash.example/api/links', { headers });

describe('Cloudflare Access authentication', () => {
    test('accepts a valid token from the header or the cookie', async () => {
        const { authenticate, sign } = await setup();
        const token = await sign({ email: 'me@example.com' });
        expect(await authenticate(req({ 'cf-access-jwt-assertion': token }))).toEqual({
            subject: 'me@example.com'
        });
        expect(await authenticate(req({ cookie: `a=b; CF_Authorization=${token}` }))).toEqual({
            subject: 'me@example.com'
        });
    });

    test('service tokens identify by common name', async () => {
        const { authenticate, sign } = await setup();
        const token = await sign({ common_name: 'client-id.access' });
        expect(await authenticate(req({ 'cf-access-jwt-assertion': token }))).toEqual({
            subject: 'client-id.access'
        });
    });

    test('rejects missing, forged, wrong-audience and wrong-issuer tokens', async () => {
        const { authenticate, sign } = await setup();
        const other = await setup();
        expect(await authenticate(req({}))).toBeNull();
        expect(await authenticate(req({ 'cf-access-jwt-assertion': 'garbage' }))).toBeNull();
        const forged = await other.sign({ email: 'x@example.com' });
        expect(await authenticate(req({ 'cf-access-jwt-assertion': forged }))).toBeNull();
        const wrongAud = await sign({ email: 'x' }, { aud: 'other' });
        expect(await authenticate(req({ 'cf-access-jwt-assertion': wrongAud }))).toBeNull();
        const wrongIss = await sign({ email: 'x' }, { iss: 'https://evil.cloudflareaccess.com' });
        expect(await authenticate(req({ 'cf-access-jwt-assertion': wrongIss }))).toBeNull();
    });

    test('no config means local development: everything allowed', async () => {
        expect(await createAuthenticator(null)(req({}))).toEqual({ subject: 'local-dev' });
    });
});
