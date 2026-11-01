import { describe, expect, test } from 'bun:test';

import { iosVersion, modelFromScreen, refineApple } from '../src/analytics/apple.ts';
import { ClickBuffer } from '../src/analytics/clicks.ts';
import { parseUserAgent } from '../src/analytics/ua.ts';
import { openDatabase } from '../src/db/client.ts';
import type { RawClick } from '../src/shared/types.ts';

const SAFARI_17 =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// iOS 26: the OS token is frozen at 18_6, Version/ has the real one.
const SAFARI_26 =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0.1 Mobile/15E148 Safari/604.1';
const CHROME_IOS =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1';
const INSTAGRAM =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0 (iPhone16,1; iOS 26_0_1; en_US; en; scale=3.00; 1179x2556; 0)';
const FACEBOOK =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0;FBBV/1;FBDV/iPhone14,7;FBMD/iPhone;FBSN/iOS;FBSV/17.4;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]';
const IPAD =
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15';

describe('iOS version', () => {
    test('from the OS token', () => {
        expect(iosVersion(SAFARI_17)).toBe('17.5.1');
        expect(iosVersion(CHROME_IOS)).toBe('17.7');
        expect(iosVersion(IPAD)).toBe('17.0');
    });

    test('iOS 26+ Safari: from Version/', () => {
        expect(iosVersion(SAFARI_26)).toBe('26.0.1');
    });

    test('in-app browsers report the real version', () => {
        expect(iosVersion(INSTAGRAM)).toBe('26.0.1');
        expect(iosVersion(FACEBOOK)).toBe('17.4');
    });

    test('parsed with the user agent', () => {
        expect(parseUserAgent(SAFARI_26)).toMatchObject({ os: 'iOS', osVersion: '26.0.1' });
        expect(parseUserAgent(IPAD_DESKTOP).osVersion).toBeNull();
    });
});

describe('model', () => {
    test('exact from an in-app hardware identifier', () => {
        expect(parseUserAgent(INSTAGRAM).model).toBe('Apple iPhone 15 Pro');
        expect(parseUserAgent(FACEBOOK).model).toBe('Apple iPhone 14');
        expect(parseUserAgent(SAFARI_17).model).toBe('Apple iPhone');
    });

    test('narrowed down by screen, either orientation', () => {
        const name = 'Apple iPhone 14 Pro, 15, 15 Pro or 16';
        expect(modelFromScreen('393x852@3', 'iPhone')).toBe(name);
        expect(modelFromScreen('852x393@3', 'iPhone')).toBe(name);
        expect(modelFromScreen('820x1180@2', 'iPad')).toBe(
            'Apple iPad (10th gen or later) or Air 11″'
        );
        expect(modelFromScreen('1920x1080@1', 'iPhone')).toBeNull();
    });

    test('refining keeps an exact model', () => {
        expect(
            refineApple(
                { ua: INSTAGRAM, os: 'iOS', model: 'Apple iPhone 15 Pro' },
                { screen: '393x852@3', touchPoints: 5 }
            )?.model
        ).toBe('Apple iPhone 15 Pro');
    });

    test('an iPad in desktop mode is an iPad', () => {
        expect(
            refineApple(
                { ua: IPAD_DESKTOP, os: 'macOS', model: 'Apple' },
                { screen: '1024x1366@2', touchPoints: 5 }
            )
        ).toEqual({
            os: 'iOS',
            device: 'tablet',
            osVersion: '18.2',
            model: 'Apple iPad Pro 12.9″ or Air 13″'
        });
        // A real Mac has no touch screen.
        expect(
            refineApple(
                { ua: IPAD_DESKTOP, os: 'macOS', model: 'Apple' },
                { screen: '1440x900@2', touchPoints: 0 }
            )
        ).toBeNull();
    });
});

const click = (ua: string, token: string | null): RawClick => ({
    linkId: 1,
    ts: Date.now(),
    url: 'https://example.com/',
    ip: '192.0.2.1',
    ua,
    referrer: '',
    country: '',
    region: '',
    city: '',
    continent: '',
    regionCode: '',
    postalCode: '',
    metroCode: '',
    ray: '',
    asn: '',
    asOrg: '',
    qr: false,
    query: '',
    language: '',
    timezone: '',
    token,
    latitude: '',
    longitude: ''
});

function setup() {
    const db = openDatabase(':memory:');
    db.run(
        `INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'a', 'https://e.x', 0, 0)`
    );
    return db;
}

function rows(db: ReturnType<typeof setup>) {
    return db
        .query<{ os: string; os_version: string | null; device: string; device_model: string }, []>(
            'SELECT os, os_version, device, device_model FROM clicks ORDER BY id'
        )
        .all();
}

describe('stored clicks', () => {
    test('browser signals refine the model', () => {
        const db = setup();
        const buffer = new ClickBuffer(db, { shortHost: 's.example', salt: 'salt' });
        for (const c of [click(SAFARI_26, 'phone'), click(IPAD_DESKTOP, 'ipad')]) buffer.push(c);
        buffer.flush();
        expect(rows(db)[0]).toEqual({
            os: 'iOS',
            os_version: '26.0.1',
            device: 'mobile',
            device_model: 'Apple iPhone'
        });
        buffer.pushSignals('phone', JSON.stringify({ screen: '402x874@3', touch: 5 }), Date.now());
        buffer.pushSignals('ipad', JSON.stringify({ screen: '834x1210@2', touch: 5 }), Date.now());
        buffer.flush();
        expect(rows(db)).toEqual([
            {
                os: 'iOS',
                os_version: '26.0.1',
                device: 'mobile',
                device_model: 'Apple iPhone 16 Pro, 17 or 17 Pro'
            },
            {
                os: 'iOS',
                os_version: '18.2',
                device: 'tablet',
                device_model: 'Apple iPad Pro 11″ (M4 or later)'
            }
        ]);
    });
});
