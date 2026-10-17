// Discord webhooks: clicks as embeds, batched to stay inside Discord's rate limits
// (about 5 requests per 2 s and 30 a minute per webhook).
import type { LinkClickedEvent } from './payload.ts';

/** Embeds per message (Discord's maximum). */
export const MAX_EMBEDS = 10;
/** Messages to one Discord endpoint are at least this far apart. */
export const DISCORD_INTERVAL_MS = 2000;

// Discord's field limits.
const TITLE_MAX = 256;
const FIELD_MAX = 1024;
const FOOTER_MAX = 2048;

// Discord blurple (#5865F2) and amber (#F0B232) for flagged clicks.
const COLOR = 5_793_266;
const COLOR_FLAGGED = 15_774_258;

export interface DiscordEmbed {
    title?: string;
    url?: string;
    description?: string;
    color?: number;
    timestamp?: string;
    fields?: { name: string; value: string; inline?: boolean }[];
    footer?: { text: string };
}

export interface DiscordMessage {
    embeds: DiscordEmbed[];
    /** Never ping anyone, whatever a title or referrer says. */
    allowed_mentions: { parse: [] };
}

/** U+1F1E6, the regional indicator for "A"; flags are two of these. */
const REGIONAL_INDICATOR_A = 127_462;

function flag(code: string | null): string {
    if (!code || !/^[A-Z]{2}$/.test(code)) return '';
    return `${String.fromCodePoint(...[...code].map(c => REGIONAL_INDICATOR_A + (c.codePointAt(0) ?? 65) - 65))} `;
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Text Discord shows literally: no markdown, links or mentions from visitor-controlled data. */
function plain(text: string): string {
    return text.replaceAll(/[\\*_~`|>[\]()#@<:-]/g, String.raw`\$&`);
}

function joined(parts: (string | null | undefined)[], separator = ' · '): string | null {
    const kept = parts.filter((p): p is string => Boolean(p));
    return kept.length > 0 ? kept.join(separator) : null;
}

/** One embed for one click. */
export function clickEmbed(event: LinkClickedEvent, dashOrigin: string): DiscordEmbed {
    const { link, click } = event.data;
    const fields: NonNullable<DiscordEmbed['fields']> = [];
    const field = (name: string, value: string | null, inline = true) => {
        if (value) fields.push({ name, value: clip(value, FIELD_MAX), inline });
    };

    const place = joined([click.city, click.region, click.country], ', ');
    field('Location', place && `${flag(click.country)}${plain(place)}`);
    const source = joined([click.source, click.referrerHost]);
    field('Source', source && plain(source));
    const device = joined([click.browser, joined([click.os, click.osVersion], ' '), click.device]);
    field('Device', device && plain(device));
    const utm = joined([
        click.utm.campaign && `campaign ${click.utm.campaign}`,
        click.utm.source && `source ${click.utm.source}`,
        click.utm.medium && `medium ${click.utm.medium}`
    ]);
    field('UTM', utm && plain(utm));
    if (click.qr) field('QR', 'Scanned');
    const flags = joined([
        click.flags.bot && `Bot: ${click.flags.bot}`,
        click.flags.vpn && `VPN: ${click.flags.vpn}`,
        click.flags.datacenter ? 'Datacenter' : null,
        click.flags.scraper && `Scraper: ${click.flags.scraper}`,
        click.flags.abuseScore !== null && click.flags.abuseScore > 0
            ? `Abuse ${click.flags.abuseScore}`
            : null
    ]);
    field('Flags', flags && plain(flags), false);
    if (click.ip !== undefined) field('IP', click.ip && `\`${click.ip.replaceAll('`', '')}\``);
    if (click.userAgent !== undefined) {
        field('User agent', click.userAgent && plain(click.userAgent), false);
    }

    const short = link.shortUrl.replace(/^https?:\/\//, '');
    return {
        title: clip(`Click on ${short}`, TITLE_MAX),
        url: `${dashOrigin}/links/${link.id}`,
        ...(link.title && { description: clip(plain(link.title), FIELD_MAX) }),
        color: flags ? COLOR_FLAGGED : COLOR,
        timestamp: click.ts,
        fields,
        footer: { text: clip(`→ ${link.url}`, FOOTER_MAX) }
    };
}

/**
 * One message for a batch of clicks, oldest first. Past 10 clicks, the newest 9
 * get embeds and the rest are counted in a summary embed.
 */
export function clicksMessage(events: LinkClickedEvent[], dashOrigin: string): DiscordMessage {
    if (events.length <= MAX_EMBEDS) {
        return {
            embeds: events.map(e => clickEmbed(e, dashOrigin)),
            allowed_mentions: { parse: [] }
        };
    }
    const shown = events.slice(-(MAX_EMBEDS - 1));
    const rest = events.slice(0, events.length - shown.length);
    const counts = new Map<string, number>();
    for (const e of rest) {
        const short = e.data.link.shortUrl.replace(/^https?:\/\//, '');
        counts.set(short, (counts.get(short) ?? 0) + 1);
    }
    const lines = [...counts]
        .toSorted((a, b) => b[1] - a[1])
        .map(([short, n]) => `${plain(short)}: ${n}`);
    const summary: DiscordEmbed = {
        title: `+${rest.length} more ${rest.length === 1 ? 'click' : 'clicks'}`,
        description: clip(lines.join('\n'), FIELD_MAX * 4),
        color: COLOR,
        timestamp: rest.at(-1)?.data.click.ts
    };
    return {
        embeds: [summary, ...shown.map(e => clickEmbed(e, dashOrigin))],
        allowed_mentions: { parse: [] }
    };
}

export function testMessage(): DiscordMessage {
    return {
        embeds: [
            {
                title: 'Webhook connected ✅',
                description: 'Clicks on your short links will show up here.',
                color: COLOR
            }
        ],
        allowed_mentions: { parse: [] }
    };
}

/**
 * How long to wait before the next message, from Discord's response: the 429
 * `retry_after`, or the bucket reset when no requests remain. Null = no wait.
 */
export async function discordWaitMs(res: Response): Promise<number | null> {
    if (res.status === 429) {
        let seconds = Number(res.headers.get('retry-after'));
        try {
            const body = (await res.json()) as { retry_after?: unknown };
            if (typeof body.retry_after === 'number') seconds = body.retry_after;
        } catch {
            // No JSON body: use the header.
        }
        return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 5000;
    }
    if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset-after'));
        if (Number.isFinite(reset) && reset > 0) return Math.ceil(reset * 1000);
    }
    return null;
}
