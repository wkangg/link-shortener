// Shared by the redirect hot path, the API and the dashboard. No runtime imports.

/** Valid slugs: 1-64 characters of A-Z, a-z, 0-9, `_` and `-`. Case-sensitive. */
export const SLUG_RE = /^[\w-]{1,64}$/;

/**
 * The root link (the bare short domain, `/`) is an ordinary link stored with an
 * empty slug. The API and the dashboard spell it `/`.
 */
export const ROOT_SLUG = '';
export const ROOT_SLUG_INPUT = '/';

export const RANDOM_SLUG_LENGTH = 6;

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A random base62 slug (rejection sampling, so every character is equally likely). */
export function randomSlug(length = RANDOM_SLUG_LENGTH): string {
    let out = '';
    const bytes = new Uint8Array(length * 2);
    while (out.length < length) {
        crypto.getRandomValues(bytes);
        for (const b of bytes) {
            // 248 = 62 * 4: values at or above it would bias the distribution.
            if (b < 248) out += ALPHABET.charAt(b % 62);
            if (out.length === length) break;
        }
    }
    return out;
}
