import type { RawClick } from '../shared/types.ts';
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
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
type UtmKey = (typeof UTM_KEYS)[number];
const UTM_SET = new Set<string>(UTM_KEYS);

const MAX_PARAMS = 20;
const MAX_VALUE = 200;
const MAX_REFERRER = 500;
const MAX_IP = 64;
const MAX_USER_AGENT = 512;

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
        is_bot: ua.isBot ? 1 : 0,
        visitor_hash: visitorHash(click, opts.salt),
        ...utm,
        query: otherParams(params),
        ip: clean(click.ip.slice(0, MAX_IP)),
        user_agent: clean(click.ua.slice(0, MAX_USER_AGENT))
    };
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

/** Cloudflare sends non-ASCII city/region names percent-encoded in some setups. */
function decodeHeader(value: string): string {
    if (!value.includes('%')) return value;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
