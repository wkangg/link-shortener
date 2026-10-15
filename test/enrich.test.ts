import { describe, expect, test } from 'bun:test';

import { enrichClick } from '../src/analytics/enrich.ts';
import { deriveSource, referrerHost, sourceForHost } from '../src/analytics/source.ts';
import { parseUserAgent } from '../src/analytics/ua.ts';
import type { RawClick } from '../src/shared/types.ts';

const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const CHROME_WIN =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SLACKBOT = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';

const base: RawClick = {
    linkId: 1,
    ts: Date.UTC(2026, 9, 15, 12),
    url: 'https://example.com/',
    ip: '1.2.3.4',
    ua: CHROME_WIN,
    referrer: '',
    country: 'CA',
    region: 'Ontario',
    city: 'Toronto',
    qr: false,
    query: ''
};
const opts = { shortHost: 's.example', salt: 'salt' };

describe('user agents', () => {
    test('browser, os and device', () => {
        expect(parseUserAgent(IPHONE)).toEqual({
            browser: 'Safari',
            os: 'iOS',
            device: 'mobile',
            isBot: false
        });
        expect(parseUserAgent(CHROME_WIN)).toMatchObject({
            browser: 'Chrome',
            os: 'Windows',
            device: 'desktop'
        });
    });

    test('bots', () => {
        expect(parseUserAgent(SLACKBOT).isBot).toBe(true);
        expect(parseUserAgent('').isBot).toBe(false);
    });
});

describe('sources', () => {
    test('referrer hosts', () => {
        expect(referrerHost('https://www.reddit.com/r/x')).toBe('reddit.com');
        expect(referrerHost('android-app://com.slack/')).toBe('com.slack');
        expect(referrerHost('nonsense')).toBeNull();
        expect(referrerHost('')).toBeNull();
    });

    test('known hosts, including subdomains', () => {
        expect(sourceForHost('t.co')).toBe('X');
        expect(sourceForHost('l.instagram.com')).toBe('Instagram');
        expect(sourceForHost('news.ycombinator.com')).toBe('Hacker News');
        expect(sourceForHost('com.slack')).toBe('Slack');
        expect(sourceForHost('example.org')).toBeNull();
    });

    test('priority: QR, utm_source, known site, host, Direct', () => {
        expect(deriveSource({ qr: true, utmSource: 'nl', host: 't.co' })).toBe('QR');
        expect(deriveSource({ qr: false, utmSource: 'nl', host: 't.co' })).toBe('nl');
        expect(deriveSource({ qr: false, utmSource: null, host: 't.co' })).toBe('X');
        expect(deriveSource({ qr: false, utmSource: null, host: 'blog.dev' })).toBe('blog.dev');
        expect(deriveSource({ qr: false, utmSource: null, host: null })).toBe('Direct');
    });
});

describe('enrichClick', () => {
    test('UTM from the click wins; other params become JSON', () => {
        const row = enrichClick(
            { ...base, query: 'utm_source=nl&utm_campaign=launch&ref=ig&v=2' },
            opts
        );
        expect(row).toMatchObject({
            utm_source: 'nl',
            utm_campaign: 'launch',
            source: 'nl',
            query: '{"ref":"ig","v":"2"}'
        });
    });

    test("destination UTM fills the columns but doesn't override the referrer source", () => {
        const row = enrichClick(
            { ...base, url: 'https://ex.com/?utm_source=bio', referrer: 'https://t.co/a' },
            opts
        );
        expect(row.utm_source).toBe('bio');
        expect(row.source).toBe('X');
    });

    test('QR, bots, geo cleanup and self-referrals', () => {
        const row = enrichClick(
            {
                ...base,
                qr: true,
                ua: SLACKBOT,
                country: 'XX',
                city: 'S%C3%A3o%20Paulo',
                referrer: 'https://s.example/x'
            },
            opts
        );
        expect(row).toMatchObject({
            via_qr: 1,
            source: 'QR',
            is_bot: 1,
            country: null,
            city: 'São Paulo',
            referrer_host: null,
            query: null
        });
    });

    test('visitor hash is stable within a day and changes across days', () => {
        const a = enrichClick(base, opts).visitor_hash;
        const b = enrichClick({ ...base, ts: base.ts + 3_600_000 }, opts).visitor_hash;
        const c = enrichClick({ ...base, ts: base.ts + 86_400_000 }, opts).visitor_hash;
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(enrichClick({ ...base, ip: '' }, opts).visitor_hash).toBeNull();
    });
});
