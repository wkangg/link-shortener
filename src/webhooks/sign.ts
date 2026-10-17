// Standard Webhooks signing (https://www.standardwebhooks.com/), so receivers can
// verify with the `standardwebhooks` or `svix` libraries.
import { createHmac, randomBytes } from 'node:crypto';

const PREFIX = 'whsec_';
const SECRET_RE = /^whsec_[A-Za-z0-9+/]+={0,2}$/;

/** A new signing secret: `whsec_` and 32 random bytes in base64. */
export function generateSecret(): string {
    return PREFIX + randomBytes(32).toString('base64');
}

/** The key bytes of a `whsec_` secret. Throws on anything else. */
export function parseSecret(secret: string): Buffer {
    if (!SECRET_RE.test(secret)) throw new Error('Webhook secrets look like whsec_<base64>');
    const key = Buffer.from(secret.slice(PREFIX.length), 'base64');
    if (key.length < 24 || key.length > 64) {
        throw new Error('Webhook secrets hold 24 to 64 bytes');
    }
    return key;
}

/** The `webhook-signature` header value for one delivery. */
export function sign(secret: string, id: string, timestampSeconds: number, body: string): string {
    const mac = createHmac('sha256', parseSecret(secret))
        .update(`${id}.${timestampSeconds}.${body}`)
        .digest('base64');
    return `v1,${mac}`;
}

/** Headers for one signed delivery. */
export function signedHeaders(
    secret: string,
    id: string,
    timestampSeconds: number,
    body: string
): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(timestampSeconds),
        'webhook-signature': sign(secret, id, timestampSeconds, body)
    };
}
