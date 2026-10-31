import { describe, expect, test } from 'bun:test';

import { computeFingerprint } from '../src/analytics/fingerprint.ts';

const CHROME_WIN =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('computeFingerprint', () => {
    test('is stable for the same parts and order-independent of absent fields', () => {
        const a = computeFingerprint({
            ua: CHROME_WIN,
            language: 'en-US',
            timezone: 'America/Toronto'
        });
        const b = computeFingerprint({
            timezone: 'America/Toronto',
            language: 'en-US',
            ua: CHROME_WIN
        });
        expect(a).toBeString();
        expect(a).toBe(b);
    });

    test('differs when an identifying trait differs', () => {
        const base = computeFingerprint({ ua: CHROME_WIN, language: 'en-US' });
        expect(computeFingerprint({ ua: CHROME_WIN, language: 'fr-FR' })).not.toBe(base);
        expect(computeFingerprint({ ua: CHROME_WIN, language: 'en-US', gpu: 'Apple M2' })).not.toBe(
            base
        );
    });

    test('browser signals refine, but do not collide with, the header-only hash', () => {
        const headersOnly = computeFingerprint({ ua: CHROME_WIN, timezone: 'Europe/Paris' });
        const withSignals = computeFingerprint({
            ua: CHROME_WIN,
            timezone: 'Europe/Paris',
            screen: '1920x1080@1',
            gpu: 'ANGLE (NVIDIA)',
            platform: 'Windows 11',
            memory: 8,
            touchPoints: 0
        });
        expect(withSignals).toBeString();
        expect(withSignals).not.toBe(headersOnly);
    });

    test('newer traits refine the hash without changing header-only values', () => {
        // Hashed the way it was before browserVersion..settings existed.
        const legacy = Bun.hash([CHROME_WIN, 'en-US', 'UTC', '', '', '', '', ''].join('')).toString(
            36
        );
        const headersOnly = { ua: CHROME_WIN, language: 'en-US', timezone: 'UTC' };
        expect(computeFingerprint(headersOnly)).toBe(legacy);
        const fonts = computeFingerprint({ ...headersOnly, fonts: '0110' });
        expect(fonts).not.toBe(legacy);
        expect(computeFingerprint({ ...headersOnly, fonts: '0111' })).not.toBe(fonts);
        expect(computeFingerprint({ ...headersOnly, codecs: '0110' })).not.toBe(fonts);
    });

    test('nothing identifying yields null', () => {
        expect(computeFingerprint({})).toBeNull();
        expect(computeFingerprint({ ua: '', language: null, timezone: undefined })).toBeNull();
    });
});
