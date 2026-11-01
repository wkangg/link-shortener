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
    /** The whole Accept-Language header, capped. */
    accept_language: string | null;
    /** CF-Timezone: the IP's zone. Kept when the browser later reports its own. */
    ip_timezone: string | null;
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
    /** navigator.hardwareConcurrency: logical CPU cores. */
    cpu_cores: number | null;
    platform: string | null;
    touch_points: number | null;
    /** navigator.webdriver: the browser is driven by automation. */
    webdriver: 0 | 1 | null;
    /** prefers-color-scheme: dark. Shown per click, not part of the fingerprint. */
    dark_mode: 0 | 1 | null;
    timezone: string | null;
    language: string | null;
    // Fingerprint traits; shared/probes.ts reads codecs, fonts and settings.
    /** Full browser version(s) from client hints. */
    browser_version: string | null;
    /** "availWidth x availHeight x colorDepth". */
    display: string | null;
    /** One digit (0-5) per probed media type. */
    codecs: string | null;
    /** One bit per probed font. */
    fonts: string | null;
    /** One bit per probed browser setting. */
    settings: string | null;
    // Also fingerprint traits. JSON columns are re-serialized in schema order, so
    // the same browser always stores (and hashes) the same text.
    /** JSON: WebGL limits, versions and extensions. */
    webgl: string | null;
    /** Characters on the letter and punctuation keys, in US QWERTY order (Chromium only). */
    keyboard: string | null;
    /** JSON: locale, calendar, numbering, hour cycle, sample date and number. */
    intl: string | null;
    /** JSON array: navigator.languages. */
    languages: string | null;
    // Shown per click, not part of the fingerprint.
    /** Hash of a drawn canvas, or "randomized" when the browser adds noise. */
    canvas: string | null;
    /** Sum of an offline-rendered audio signal. */
    audio: string | null;
    /** JSON: color gamut, HDR, pointer and hover media features. */
    media_features: string | null;
    /** JSON array: speech synthesis voices, "Name (lang)". */
    voices: string | null;
    /** Newest emoji version the system draws in color. */
    emoji: number | null;
    /** Hash of Math function results. */
    math: string | null;
    /** JSON: counts of cameras, microphones and speakers. */
    media_devices: string | null;
    /** JSON: permission states, e.g. {"notifications":"denied"}. */
    permissions: string | null;
    /** screen.isExtended: more than one monitor (Chromium only). */
    multi_monitor: 0 | 1 | null;
    /** JSON: WebGPU adapter vendor, architecture, device, description. */
    webgpu: string | null;
    /** Window inner size, "WxH". */
    viewport: string | null;
    /** Device model from client hints (Android phones; empty elsewhere). */
    hint_model: string | null;
    /** CPU architecture and bitness from client hints, e.g. "x86 64-bit". */
    cpu_arch: string | null;
    /** Form factors from client hints, e.g. "Desktop" or "Mobile, Tablet". */
    form_factors: string | null;
    /** navigator.storage quota in bytes: roughly a share of free disk space. */
    quota: number | null;
    /** Estimated bandwidth in Mbps. */
    downlink: number | null;
    /** Estimated round-trip time in ms. */
    rtt: number | null;
    /** The Data Saver setting. */
    save_data: 0 | 1 | null;
    /** The device's Date.now() when it sent the report; not stored, see ClickBuffer. */
    client_clock: number | null;
}

type TraitKind = 'str' | 'int' | 'bool' | 'strs';

const WEBGL_SCHEMA: Record<string, TraitKind> = {
    version: 'str',
    shading: 'str',
    vendor: 'str',
    maxTexture: 'int',
    maxCubeMap: 'int',
    maxRenderbuffer: 'int',
    maxViewport: 'str',
    textureUnits: 'int',
    vertexTextureUnits: 'int',
    combinedTextureUnits: 'int',
    vertexAttribs: 'int',
    varyingVectors: 'int',
    vertexUniforms: 'int',
    fragmentUniforms: 'int',
    lineWidth: 'str',
    pointSize: 'str',
    precision: 'str',
    antialias: 'bool',
    extensions: 'strs'
};
const INTL_SCHEMA: Record<string, TraitKind> = {
    locale: 'str',
    calendar: 'str',
    numbering: 'str',
    hourCycle: 'str',
    date: 'str',
    number: 'str'
};
const MEDIA_FEATURES_SCHEMA: Record<string, TraitKind> = {
    gamut: 'str',
    hdr: 'bool',
    pointer: 'str',
    anyPointer: 'str',
    hover: 'bool',
    anyHover: 'bool',
    monochrome: 'bool'
};
const MEDIA_DEVICES_SCHEMA: Record<string, TraitKind> = {
    cameras: 'int',
    microphones: 'int',
    speakers: 'int'
};
const PERMISSIONS_SCHEMA: Record<string, TraitKind> = {
    geolocation: 'str',
    notifications: 'str',
    camera: 'str',
    microphone: 'str',
    'persistent-storage': 'str',
    midi: 'str',
    'clipboard-read': 'str'
};
const WEBGPU_SCHEMA: Record<string, TraitKind> = {
    vendor: 'str',
    architecture: 'str',
    device: 'str',
    description: 'str'
};
const MAX_TRAIT_TEXT = 120;
const MAX_LIST = 100;

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
const BROWSER_VERSION_RE = /^[\w .,;()-]{1,200}$/;
const DISPLAY_RE = /^\d{1,5}x\d{1,5}x\d{1,2}$/;
const CODECS_RE = /^[0-5]{1,64}$/;
const BITS_RE = /^[01]{1,64}$/;
const HASH_RE = /^(?:[0-9a-f]{1,16}|randomized)$/;
const AUDIO_RE = /^\d{1,6}(?:\.\d{1,20})?(?:e-?\d{1,3})?$/;
const VIEWPORT_RE = /^\d{1,5}x\d{1,5}$/;
const ARCH_RE = /^[\w-]{1,16}$/;
const BITNESS_RE = /^\d{2}$/;
const MAX_ACCEPT_LANGUAGE = 200;
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
    /** Secret mixed into the visitor hash. */
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
    const ip = clean(click.ip.slice(0, MAX_IP));
    const userAgent = clean(click.ua.slice(0, MAX_USER_AGENT));

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
        visitor_hash: visitorHash(ip, userAgent, opts.salt),
        ...utm,
        query: otherParams(params),
        ip,
        user_agent: userAgent,
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
        js: click.token ? 0 : null,
        accept_language: clean(click.language.slice(0, MAX_ACCEPT_LANGUAGE)),
        ip_timezone: tz
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
    const match = (key: string, re: RegExp) => (re.test(str(key)) ? str(key) : null);
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
        cpu_cores:
            typeof s.cores === 'number' &&
            Number.isInteger(s.cores) &&
            s.cores >= 1 &&
            s.cores <= 1024
                ? s.cores
                : null,
        platform: PLATFORM_RE.test(str('platform')) ? clean(str('platform')) : null,
        touch_points:
            typeof s.touch === 'number' &&
            Number.isInteger(s.touch) &&
            s.touch >= 0 &&
            s.touch <= 100
                ? s.touch
                : null,
        webdriver: flag('webdriver'),
        dark_mode: flag('darkMode'),
        timezone: timezone(str('timezone')),
        language: language(str('language')),
        browser_version: match('browserVersion', BROWSER_VERSION_RE),
        display: match('display', DISPLAY_RE),
        codecs: match('codecs', CODECS_RE),
        fonts: match('fonts', BITS_RE),
        settings: match('settings', BITS_RE),
        webgl: traitRecord(s.webgl, WEBGL_SCHEMA),
        keyboard: traitText(s.keyboard, 64),
        intl: traitRecord(s.intl, INTL_SCHEMA),
        languages: jsonOrNull(
            traitList(s.languages, 20)
                ?.map(l => language(l))
                .filter(l => l !== null) ?? []
        ),
        canvas: match('canvas', HASH_RE),
        audio: match('audio', AUDIO_RE),
        media_features: traitRecord(s.mediaFeatures, MEDIA_FEATURES_SCHEMA),
        voices: jsonOrNull(traitList(s.voices, MAX_LIST) ?? []),
        emoji:
            typeof s.emoji === 'number' &&
            Number.isInteger(s.emoji) &&
            s.emoji >= 0 &&
            s.emoji <= 99
                ? s.emoji
                : null,
        math: match('math', HASH_RE),
        media_devices: traitRecord(s.mediaDevices, MEDIA_DEVICES_SCHEMA),
        permissions: traitRecord(s.permissions, PERMISSIONS_SCHEMA),
        multi_monitor: flag('multiMonitor'),
        webgpu: traitRecord(s.webgpu, WEBGPU_SCHEMA),
        viewport: match('viewport', VIEWPORT_RE),
        hint_model: traitText(s.model, 60),
        cpu_arch: cpuArch(s),
        form_factors: traitList(s.formFactors, 5)?.join(', ') || null,
        quota: number(s.quota, 1e16, true),
        downlink: number(s.downlink, 100_000, false),
        rtt: number(s.rtt, 60_000, true),
        save_data: flag('saveData'),
        client_clock: number(s.clock, 1e14, true)
    };
}

/** A finite number in [0, max], optionally whole; else null. */
function number(value: unknown, max: number, integer: boolean): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max)
        return null;
    return integer ? Math.round(value) : value;
}

/** "x86 64-bit" / "arm 64-bit", noting a 32-bit browser on 64-bit Windows. */
function cpuArch(s: Record<string, unknown>): string | null {
    const arch =
        typeof s.architecture === 'string' && ARCH_RE.test(s.architecture) ? s.architecture : null;
    const bits = typeof s.bitness === 'string' && BITNESS_RE.test(s.bitness) ? s.bitness : null;
    if (!arch) return null;
    return `${arch}${bits ? ` ${bits}-bit` : ''}${s.wow64 === true ? ' (32-bit browser)' : ''}`;
}

/** Printable text, trimmed and capped; null when empty or not a string. */
function traitText(value: unknown, max = MAX_TRAIT_TEXT): string | null {
    if (typeof value !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    return clean(value.replaceAll(/[\u0000-\u001F\u007F]/g, '').slice(0, max));
}

/** A list of printable strings, capped; null when not an array. */
function traitList(value: unknown, max: number): string[] | null {
    if (!Array.isArray(value)) return null;
    return value
        .slice(0, max)
        .map(v => traitText(v))
        .filter(v => v !== null);
}

function jsonOrNull(list: string[]): string | null {
    return list.length > 0 ? JSON.stringify(list) : null;
}

/** Keeps only the schema's keys, in schema order, with values of the right kind; JSON or null. */
function traitRecord(value: unknown, schema: Record<string, TraitKind>): string | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const out: Record<string, string | number | boolean | string[]> = {};
    for (const [key, kind] of Object.entries(schema)) {
        const v = traitValue(raw[key], kind);
        if (v !== null) out[key] = v;
    }
    return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

function traitValue(v: unknown, kind: TraitKind): string | number | boolean | string[] | null {
    switch (kind) {
        case 'str':
            return traitText(v);
        case 'int':
            return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
        case 'bool':
            return typeof v === 'boolean' ? v : null;
        case 'strs':
            return traitList(v, MAX_LIST);
    }
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
    const out: Record<string, string> = Object.create(null);
    let count = 0;
    for (const [key, value] of params) {
        if (UTM_SET.has(key) || key === '' || Object.hasOwn(out, key)) continue;
        out[key.slice(0, 64)] = value.slice(0, MAX_VALUE);
        if (++count >= MAX_PARAMS) break;
    }
    return count > 0 ? JSON.stringify(out) : null;
}

/** Identifies a unique visitor: the same IP and user agent always hash the same, across days. */
function visitorHash(ip: string | null, userAgent: string | null, salt: string): string | null {
    if (!ip) return null;
    return Bun.hash(`${salt}|${ip}|${userAgent ?? ''}`).toString(36);
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
