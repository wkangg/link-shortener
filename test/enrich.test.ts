import { describe, expect, test } from 'bun:test';

import { enrichClick, parseSignals } from '../src/analytics/enrich.ts';
import { deriveSource, referrerHost, sourceForHost } from '../src/analytics/source.ts';
import { parseUserAgent } from '../src/analytics/ua.ts';
import { fixUtf8ReadAsLatin1 } from '../src/shared/text.ts';
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
    query: '',
    language: '',
    timezone: '',
    token: null,
    latitude: '',
    longitude: ''
};
const opts = { shortHost: 's.example', salt: 'salt' };

describe('header encoding', () => {
    test('UTF-8 read as Latin-1 is decoded', () => {
        expect(fixUtf8ReadAsLatin1('MontrÃ©al')).toBe('Montréal');
        expect(fixUtf8ReadAsLatin1('QuÃ©bec')).toBe('Québec');
        expect(fixUtf8ReadAsLatin1('SÃ£o Paulo')).toBe('São Paulo');
    });

    test('correct text is left alone', () => {
        for (const s of ['Montréal', 'Toronto', '東京', 'Zürich', '']) {
            expect(fixUtf8ReadAsLatin1(s)).toBe(s);
        }
    });

    test('enrich fixes city and region', () => {
        const row = enrichClick({ ...base, city: 'MontrÃ©al', region: 'QuÃ©bec' }, opts);
        expect(row).toMatchObject({ city: 'Montréal', region: 'Québec' });
    });
});

describe('click history fields', () => {
    test('raw ip and user agent are stored, capped', () => {
        expect(enrichClick(base, opts)).toMatchObject({ ip: '1.2.3.4', user_agent: CHROME_WIN });
        const empty = enrichClick({ ...base, ip: '', ua: 'x'.repeat(2000) }, opts);
        expect(empty.ip).toBeNull();
        expect(empty.user_agent).toHaveLength(512);
    });
});

describe('extra click fields', () => {
    test('language, timezone, bot name and device model', () => {
        const row = enrichClick(
            { ...base, language: 'fr-CA,fr;q=0.9,en;q=0.8', timezone: 'America/Toronto' },
            opts
        );
        expect(row).toMatchObject({
            language: 'fr-CA',
            timezone: 'America/Toronto',
            bot_name: null
        });
        expect(enrichClick({ ...base, language: '*', timezone: '<x>' }, opts)).toMatchObject({
            language: null,
            timezone: null
        });
        expect(enrichClick({ ...base, ua: SLACKBOT }, opts)).toMatchObject({
            is_bot: 1,
            bot_name: 'SlackBot',
            device_model: null
        });
        expect(parseUserAgent('curl/8.4.0').botName).toBe('curl');
        expect(
            parseUserAgent('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)')
        ).toMatchObject({ isBot: true, botName: 'Discordbot' });
        expect(
            parseUserAgent(
                'visionheight.com/scan Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0.0.0 Safari/537.36'
            )
        ).toMatchObject({ isBot: true, botName: 'visionheight.com' });
        expect(
            parseUserAgent(
                'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
            ).model
        ).toBe('Pixel 8');
    });

    test('edge coordinates are range-checked', () => {
        expect(
            enrichClick({ ...base, latitude: '43.6532', longitude: '-79.3832' }, opts)
        ).toMatchObject({ latitude: 43.6532, longitude: -79.3832 });
        expect(enrichClick({ ...base, latitude: '91', longitude: 'abc' }, opts)).toMatchObject({
            latitude: null,
            longitude: null
        });
        expect(enrichClick(base, opts)).toMatchObject({ latitude: null, longitude: null });
    });

    test('device signals are validated field by field', () => {
        expect(
            parseSignals(
                JSON.stringify({
                    t: 'tok',
                    screen: '1920x1080@1.25',
                    orientation: 'landscape-primary',
                    battery: 87,
                    charging: true,
                    connection: 'wifi',
                    gpu: 'ANGLE (NVIDIA GeForce RTX 4070)',
                    incognito: false,
                    adBlocker: true,
                    timezone: 'Europe/Paris',
                    language: 'en-GB',
                    memory: 8,
                    cores: 12,
                    platform: 'Windows 11',
                    touch: 10,
                    webdriver: false
                })
            )
        ).toEqual({
            screen: '1920x1080@1.25',
            orientation: 'landscape-primary',
            battery: 87,
            charging: 1,
            connection: 'wifi',
            gpu: 'ANGLE (NVIDIA GeForce RTX 4070)',
            incognito: 0,
            ad_blocker: 1,
            memory: 8,
            cpu_cores: 12,
            platform: 'Windows 11',
            touch_points: 10,
            webdriver: 0,
            timezone: 'Europe/Paris',
            language: 'en-GB'
        });
        expect(
            parseSignals(
                JSON.stringify({
                    screen: '0x0@1',
                    battery: 140,
                    charging: 'yes',
                    connection: 'fiber'
                })
            )
        ).toMatchObject({ screen: null, battery: null, charging: null, connection: null });
        expect(
            parseSignals(JSON.stringify({ memory: -1, cores: 0, platform: '<b>x</b>', touch: 2.5 }))
        ).toMatchObject({ memory: null, cpu_cores: null, platform: null, touch_points: null });
        expect(parseSignals(JSON.stringify({ cores: 1.5 }))).toMatchObject({ cpu_cores: null });
        expect(parseSignals('not json')).toBeNull();
        expect(parseSignals('[1]')).toMatchObject({ screen: null });
    });
});

describe('fingerprint and datacenter', () => {
    test('a fingerprint is derived from the headers and is independent of time and IP', () => {
        const row = enrichClick(base, opts);
        expect(row.fingerprint).toBeString();
        expect(row.is_datacenter).toBe(0);
        // Same device, different click time and IP: same fingerprint.
        expect(enrichClick({ ...base, ts: base.ts + 9999, ip: '9.9.9.9' }, opts).fingerprint).toBe(
            row.fingerprint
        );
        // Different browser: different fingerprint.
        expect(enrichClick({ ...base, ua: IPHONE }, opts).fingerprint).not.toBe(row.fingerprint);
    });

    test('no identifying headers means no fingerprint', () => {
        expect(
            enrichClick({ ...base, ua: '', language: '', timezone: '' }, opts).fingerprint
        ).toBeNull();
    });
});

describe('user agents', () => {
    test('browser, os and device', () => {
        expect(parseUserAgent(IPHONE)).toEqual({
            browser: 'Safari',
            os: 'iOS',
            osVersion: '17.0',
            device: 'mobile',
            isBot: false,
            botName: null,
            model: 'Apple iPhone'
        });
        expect(parseUserAgent(CHROME_WIN)).toMatchObject({
            browser: 'Chrome',
            os: 'Windows',
            device: 'desktop'
        });
    });

    test('unrecognized user agents have no browser or os', () => {
        expect(parseUserAgent('curl/8.4.0')).toMatchObject({ browser: null, os: null });
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

    test('params named like Object methods are kept', () => {
        const row = enrichClick({ ...base, query: 'toString=1&constructor=2&__proto__=3' }, opts);
        expect(row.query).toBe('{"toString":"1","constructor":"2","__proto__":"3"}');
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

    test('visitor hash is stable across days and changes with IP or user agent', () => {
        const a = enrichClick(base, opts).visitor_hash;
        const b = enrichClick({ ...base, ts: base.ts + 30 * 86_400_000 }, opts).visitor_hash;
        expect(a).toBe(b);
        expect(enrichClick({ ...base, ip: '192.0.2.99' }, opts).visitor_hash).not.toBe(a);
        expect(enrichClick({ ...base, ua: 'curl/8.0' }, opts).visitor_hash).not.toBe(a);
        expect(enrichClick({ ...base, ip: '' }, opts).visitor_hash).toBeNull();
    });
});
