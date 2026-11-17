import { describe, expect, test } from 'bun:test';

import { isExpired } from '../src/dashboard/client/format.ts';

describe('isExpired', () => {
    test('compares the expiry with now, as the redirect does', () => {
        const now = 1_700_000_000_000;
        expect(isExpired(null, now)).toBe(false);
        expect(isExpired(now + 1, now)).toBe(false);
        expect(isExpired(now, now)).toBe(true);
        expect(isExpired(now - 1, now)).toBe(true);
    });
});
