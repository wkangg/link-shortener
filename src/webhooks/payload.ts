// What a webhook says about a click, read back from the database at send time so
// it carries verdicts that landed after the insert (hostname, VPN, abuse score).
import type { Database } from 'bun:sqlite';

import { SIGNALS_WINDOW_MS } from '../analytics/classify.ts';
import { EXPIRE_INTERVAL_MS } from '../analytics/clicks.ts';
import type { WebhookSkipCategory } from '../shared/types.ts';

/** A click as stored, with its link. Link fields are null if the link was deleted. */
export interface ClickSnapshot {
    id: number;
    ts: number;
    link_id: number;
    slug: string | null;
    url: string | null;
    title: string | null;
    tags: string[];
    country: string | null;
    region: string | null;
    city: string | null;
    source: string;
    referrer_host: string | null;
    via_qr: number;
    device: string | null;
    browser: string | null;
    os: string | null;
    os_version: string | null;
    /** From the device page, e.g. "Windows 11" (tracked links, Chromium only). */
    platform: string | null;
    language: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    utm_term: string | null;
    utm_content: string | null;
    visitor_hash: string | null;
    /** null = no device page served, 0 = served but no report yet, 1 = reported. */
    js: number | null;
    is_bot: number;
    bot_name: string | null;
    is_datacenter: number;
    vpn: string | null;
    scraper: string | null;
    abuse_score: number | null;
    ip: string | null;
    user_agent: string | null;
}

export type ClickReader = (id: number) => ClickSnapshot | null;

/** Reads a click and its link in one go. */
export function createClickReader(db: Database): ClickReader {
    const click = db.query<Omit<ClickSnapshot, 'tags'>, [number]>(
        `SELECT c.id, c.ts, c.link_id, l.slug, l.url, l.title, c.country, c.region, c.city,
                c.source, c.referrer_host, c.via_qr, c.device, c.browser, c.os, c.os_version, c.platform,
                c.language, c.utm_source, c.utm_medium, c.utm_campaign, c.utm_term, c.utm_content,
                c.visitor_hash, c.js, c.is_bot, c.bot_name, c.is_datacenter, c.vpn, c.scraper,
                c.abuse_score, c.ip, c.user_agent
         FROM clicks c LEFT JOIN links l ON l.id = c.link_id WHERE c.id = ?`
    );
    const tags = db.query<{ tag: string }, [number]>(
        'SELECT tag FROM link_tags WHERE link_id = ? ORDER BY tag'
    );
    return id => {
        const row = click.get(id);
        return row ? { ...row, tags: tags.all(row.link_id).map(r => r.tag) } : null;
    };
}

/**
 * The first category in `skip` the click falls into, or null to send it. Mirrors
 * the dashboard's filters: a datacenter IP that is a known VPN counts as a VPN.
 */
export function skipReason(
    click: ClickSnapshot,
    skip: ReadonlySet<WebhookSkipCategory>,
    abuseMinScore: number
): WebhookSkipCategory | null {
    if (skip.has('bot') && click.is_bot === 1) return 'bot';
    if (skip.has('scraper') && click.scraper !== null) return 'scraper';
    if (skip.has('datacenter') && click.is_datacenter === 1 && click.vpn === null) {
        return 'datacenter';
    }
    if (skip.has('abusive') && click.abuse_score !== null && click.abuse_score >= abuseMinScore) {
        return 'abusive';
    }
    if (skip.has('vpn') && click.vpn !== null) return 'vpn';
    return null;
}

/**
 * When a click that may still be labelled a scraper will have its verdict, or
 * null if it won't get one. A hosting IP that was served the device page and
 * hasn't reported back counts as a scraper only once the signals window is over
 * and the next token expiry has reclassified it.
 */
export function scraperVerdictAt(
    click: Pick<ClickSnapshot, 'ts' | 'js' | 'is_datacenter' | 'vpn' | 'scraper'>,
    skip: ReadonlySet<WebhookSkipCategory>
): number | null {
    if (!skip.has('scraper') || click.js !== 0 || click.scraper !== null) return null;
    if (click.is_datacenter !== 1 && !click.vpn?.startsWith('VPN host: ')) return null;
    return click.ts + SIGNALS_WINDOW_MS + EXPIRE_INTERVAL_MS;
}

/** How long a click may wait on its IP's reputation lookup before it is sent anyway. */
export const LOOKUP_WAIT_MS = 10 * 60_000;
/** How often a click waiting on its lookup is looked at again. */
export const LOOKUP_RECHECK_MS = 5000;

// Verdicts the reputation lookup can change: the datacenter flag and abuse
// score, and through the datacenter flag the scraper and VPN labels.
const LOOKUP_CATEGORIES: readonly WebhookSkipCategory[] = [
    'datacenter',
    'abusive',
    'scraper',
    'vpn'
];

/**
 * When to look at a click again because its IP's reputation lookup hasn't
 * answered yet, or null to go ahead. Gives up LOOKUP_WAIT_MS after the click,
 * e.g. when the daily quota has run out.
 */
export function lookupVerdictAt(
    click: Pick<ClickSnapshot, 'ts' | 'ip'>,
    skip: ReadonlySet<WebhookSkipCategory>,
    lookupPending: (ip: string) => boolean,
    now: number
): number | null {
    if (!click.ip || !LOOKUP_CATEGORIES.some(c => skip.has(c))) return null;
    const deadline = click.ts + LOOKUP_WAIT_MS;
    if (now >= deadline || !lookupPending(click.ip)) return null;
    return Math.min(now + LOOKUP_RECHECK_MS, deadline);
}

export interface WebhookLink {
    id: number;
    slug: string;
    shortUrl: string;
    url: string;
    title: string | null;
    tags: string[];
}

export interface WebhookClick {
    id: number;
    /** ISO 8601. */
    ts: string;
    country: string | null;
    region: string | null;
    city: string | null;
    source: string;
    referrerHost: string | null;
    qr: boolean;
    device: string | null;
    browser: string | null;
    os: string | null;
    osVersion: string | null;
    language: string | null;
    utm: {
        source: string | null;
        medium: string | null;
        campaign: string | null;
        term: string | null;
        content: string | null;
    };
    /** Salted hash of IP and user agent: the same value means the same visitor. */
    visitor: string | null;
    flags: {
        /** Crawler name, or null for a person. */
        bot: string | null;
        datacenter: boolean;
        /** The VPN or relay, e.g. "Tor". */
        vpn: string | null;
        /** Why the click looks automated. */
        scraper: string | null;
        /** AbuseIPDB confidence 0-100; null when not checked (yet). */
        abuseScore: number | null;
    };
    /** Only for endpoints that include IP addresses. */
    ip?: string | null;
    userAgent?: string | null;
}

export interface LinkClickedEvent {
    type: 'link.clicked';
    /** ISO 8601, when the event was built. */
    timestamp: string;
    data: { link: WebhookLink; click: WebhookClick };
}

export interface TestEvent {
    type: 'webhook.test';
    timestamp: string;
    data: { message: string };
}

export type WebhookEvent = LinkClickedEvent | TestEvent;

/**
 * The OS version, as the dashboard shows it. The browser-reported platform wins
 * over the user agent: user agents say "Windows NT 10.0" on both Windows 10 and 11.
 */
export function osVersionOf(
    click: Pick<ClickSnapshot, 'os' | 'os_version' | 'platform'>
): string | null {
    const { os, platform } = click;
    if (os && platform?.startsWith(`${os} `)) return platform.slice(os.length + 1);
    return click.os_version;
}

/** The short URL of a slug ('' is the root link). */
export function shortUrlOf(shortOrigin: string, slug: string): string {
    return `${shortOrigin}/${slug}`;
}

/** The `link.clicked` event for a click whose link still exists. */
export function linkClickedEvent(
    click: ClickSnapshot & { slug: string; url: string },
    opts: { shortOrigin: string; includeIp: boolean; now: number }
): LinkClickedEvent {
    return {
        type: 'link.clicked',
        timestamp: new Date(opts.now).toISOString(),
        data: {
            link: {
                id: click.link_id,
                slug: click.slug,
                shortUrl: shortUrlOf(opts.shortOrigin, click.slug),
                url: click.url,
                title: click.title,
                tags: click.tags
            },
            click: {
                id: click.id,
                ts: new Date(click.ts).toISOString(),
                country: click.country,
                region: click.region,
                city: click.city,
                source: click.source,
                referrerHost: click.referrer_host,
                qr: click.via_qr === 1,
                device: click.device,
                browser: click.browser,
                os: click.os,
                osVersion: osVersionOf(click),
                language: click.language,
                utm: {
                    source: click.utm_source,
                    medium: click.utm_medium,
                    campaign: click.utm_campaign,
                    term: click.utm_term,
                    content: click.utm_content
                },
                visitor: click.visitor_hash,
                flags: {
                    bot: click.is_bot === 1 ? (click.bot_name ?? 'unknown') : null,
                    datacenter: click.is_datacenter === 1,
                    vpn: click.vpn,
                    scraper: click.scraper,
                    abuseScore: click.abuse_score
                },
                ...(opts.includeIp && { ip: click.ip, userAgent: click.user_agent })
            }
        }
    };
}

export function testEvent(now: number): TestEvent {
    return {
        type: 'webhook.test',
        timestamp: new Date(now).toISOString(),
        data: { message: 'Webhook connected. Clicks will arrive like this one did.' }
    };
}
