import { fixUtf8ReadAsLatin1 } from '../shared/text.ts';
import type { RawClick } from '../shared/types.ts';
import { computeFingerprint } from './fingerprint.ts';
import { deriveSource, referrerHost } from './source.ts';
import { parseUserAgent } from './ua.ts';

/** Column values for one row of `clicks`, in INSERT order. */
export interface ClickRow {
    link_id: number;
    ts: number;
    country: string | null;
    region: string | null;
    city: string | null;
    referrer_host: string | null;
    referrer: string | null;
    source: string;
    via_qr: 0 | 1;
    device: string | null;
    browser: string | null;
    os: string | null;
    os_version: string | null;
    is_bot: 0 | 1;
    visitor_hash: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    utm_term: string | null;
    utm_content: string | null;
    query: string | null;
    ip: string | null;
    user_agent: string | null;
    language: string | null;
    timezone: string | null;
    bot_name: string | null;
    device_model: string | null;
    token: string | null;
    latitude: number | null;
    longitude: number | null;
    /** Coarse device fingerprint (see analytics/fingerprint.ts). */
    fingerprint: string | null;
    /** 1 when the IP is a hosting/datacenter provider; set later from the hostname. */
    is_datacenter: 0 | 1;
    /** 0 when the device-signals page was served (1 once it reports back), else null. */
    js: 0 | null;
}

/** Browser-side signals from the device-signals page, validated. Null means not reported. */
export interface DeviceSignals {
    screen: string | null;
    orientation: string | null;
    battery: number | null;
    charging: 0 | 1 | null;
    connection: string | null;
    gpu: string | null;
    incognito: 0 | 1 | null;
    ad_blocker: 0 | 1 | null;
    memory: number | null;
    platform: string | null;
    touch_points: number | null;
    /** navigator.webdriver: the browser is driven by automation. */
    webdriver: 0 | 1 | null;
    timezone: string | null;
    language: string | null;
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
type UtmKey = (typeof UTM_KEYS)[number];
const UTM_SET = new Set<string>(UTM_KEYS);

const MAX_PARAMS = 20;
const MAX_VALUE = 200;
const MAX_REFERRER = 500;
const MAX_IP = 64;
const MAX_USER_AGENT = 512;
const MAX_GPU = 200;

const LANGUAGE_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const TIMEZONE_RE = /^[A-Za-z][\w+-]*(?:\/[\w+-]+){0,2}$/;
const SCREEN_RE = /^[1-9]\d{0,4}x[1-9]\d{0,4}(?:@\d{1,2}(?:\.\d{1,2})?)?$/;
const PLATFORM_RE = /^[\w .-]{1,40}$/;
const ORIENTATIONS = new Set([
    'portrait-primary',
    'portrait-secondary',
    'landscape-primary',
    'landscape-secondary'
]);
const CONNECTIONS = new Set([
    'bluetooth',
    'cellular',
    'ethernet',
    'mixed',
    'none',
    'other',
    'wifi',
    'wimax',
    'slow-2g',
    '2g',
    '3g',
    '4g'
]);

export interface EnrichOptions {
    /** Host of the short domain; clicks referred from it are treated as Direct. */
    shortHost: string;
    /** Secret mixed into the daily visitor hash. */
    salt: string;
}

export function enrichClick(click: RawClick, opts: EnrichOptions): ClickRow {
    const params = new URLSearchParams(click.query);
    const clickUtm = utmFrom(params);
    const utm = clickUtm ?? utmFromUrl(click.url);

    let host = referrerHost(click.referrer);
    if (host === opts.shortHost) host = null;

    const ua = parseUserAgent(click.ua);
    const lang = language(click.language.split(',')[0]?.split(';')[0] ?? '');
    const tz = timezone(click.timezone);

    return {
        link_id: click.linkId,
        ts: click.ts,
        country: clean(click.country === 'XX' ? '' : click.country.toUpperCase()),
        region: clean(decodeHeader(click.region)),
        city: clean(decodeHeader(click.city)),
        referrer_host: host,
        referrer: host ? click.referrer.slice(0, MAX_REFERRER) : null,
        source: deriveSource({ qr: click.qr, utmSource: clickUtm?.utm_source ?? null, host }),
        via_qr: click.qr ? 1 : 0,
        device: ua.device,
        browser: ua.browser,
        os: ua.os,
        os_version: ua.osVersion,
        is_bot: ua.isBot ? 1 : 0,
        visitor_hash: visitorHash(click, opts.salt),
        ...utm,
        query: otherParams(params),
        ip: clean(click.ip.slice(0, MAX_IP)),
        user_agent: clean(click.ua.slice(0, MAX_USER_AGENT)),
        language: lang,
        timezone: tz,
        bot_name: ua.botName,
        device_model: ua.model,
        token: click.token,
        latitude: coordinate(click.latitude, 90),
        longitude: coordinate(click.longitude, 180),
        // Browser signals (if any) refine this later; see ClickBuffer.
        fingerprint: computeFingerprint({ ua: click.ua, language: lang, timezone: tz }),
        is_datacenter: 0,
        js: click.token ? 0 : null
    };
}

/** Parses the JSON body the device-signals page posts. Anything malformed is dropped. */
export function parseSignals(body: string): DeviceSignals | null {
    let raw: unknown;
    try {
        raw = JSON.parse(body);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const s = raw as Record<string, unknown>;
    const str = (key: string) => (typeof s[key] === 'string' ? s[key] : '');
    const flag = (key: string) => (typeof s[key] === 'boolean' ? (s[key] ? 1 : 0) : null);
    const battery = s.battery;
    return {
        screen: SCREEN_RE.test(str('screen')) ? str('screen') : null,
        orientation: ORIENTATIONS.has(str('orientation')) ? str('orientation') : null,
        battery:
            typeof battery === 'number' &&
            Number.isInteger(battery) &&
            battery >= 0 &&
            battery <= 100
                ? battery
                : null,
        charging: flag('charging'),
        connection: CONNECTIONS.has(str('connection')) ? str('connection') : null,
        gpu: clean(str('gpu').slice(0, MAX_GPU)),
        incognito: flag('incognito'),
        ad_blocker: flag('adBlocker'),
        memory: typeof s.memory === 'number' && s.memory > 0 && s.memory <= 1024 ? s.memory : null,
        platform: PLATFORM_RE.test(str('platform')) ? clean(str('platform')) : null,
        touch_points:
            typeof s.touch === 'number' &&
            Number.isInteger(s.touch) &&
            s.touch >= 0 &&
            s.touch <= 100
                ? s.touch
                : null,
        webdriver: flag('webdriver'),
        timezone: timezone(str('timezone')),
        language: language(str('language'))
    };
}

/** A latitude/longitude header as a number within ±limit, or null. */
function coordinate(value: string, limit: number): number | null {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

function language(value: string): string | null {
    const trimmed = value.trim();
    return LANGUAGE_RE.test(trimmed) && trimmed.length <= 35 ? trimmed : null;
}

function timezone(value: string): string | null {
    const trimmed = value.trim();
    return TIMEZONE_RE.test(trimmed) && trimmed.length <= 64 ? trimmed : null;
}

function utmFrom(params: URLSearchParams): Record<UtmKey, string | null> | null {
    let found = false;
    const out = {} as Record<UtmKey, string | null>;
    for (const key of UTM_KEYS) {
        const value = clean(params.get(key)?.slice(0, MAX_VALUE) ?? '');
        if (value) found = true;
        out[key] = value;
    }
    return found ? out : null;
}

function utmFromUrl(url: string): Record<UtmKey, string | null> {
    try {
        const fromUrl = utmFrom(new URL(url).searchParams);
        if (fromUrl) return fromUrl;
    } catch {
        // Unparseable destination: no UTM.
    }
    return {
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        utm_term: null,
        utm_content: null
    };
}

function otherParams(params: URLSearchParams): string | null {
    const out: Record<string, string> = {};
    let count = 0;
    for (const [key, value] of params) {
        if (UTM_SET.has(key) || key === '' || key in out) continue;
        out[key.slice(0, 64)] = value.slice(0, MAX_VALUE);
        if (++count >= MAX_PARAMS) break;
    }
    return count > 0 ? JSON.stringify(out) : null;
}

function visitorHash(click: RawClick, salt: string): string | null {
    if (click.ip === '') return null;
    const day = new Date(click.ts).toISOString().slice(0, 10);
    return Bun.hash(`${salt}|${day}|${click.ip}|${click.ua}`).toString(36);
}

function clean(value: string): string | null {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * Cloudflare sends non-ASCII city/region names as raw UTF-8 (read here as Latin-1),
 * or percent-encoded in some setups. Handles both.
 */
function decodeHeader(raw: string): string {
    const value = fixUtf8ReadAsLatin1(raw);
    if (!value.includes('%')) return value;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
