/**
 * Click search: a small query language over every stored click property.
 *
 *   firefox                  any text field contains "firefox"
 *   "san francisco"          quoted phrase
 *   isp:comcast ip:203.0.    a field contains the value
 *   ip:=203.0.113.5          a field is exactly the value (case-insensitive)
 *   ram:>=8 battery:<20      numeric comparisons (=, >, >=, <, <=)
 *   is:bot is:datacenter     flags (also is:abusive, is:private, is:adblock, is:qr, ...)
 *   has:gpu                  the field is set
 *   -os:windows -is:bot      a leading `-` negates any term
 *
 * Terms are AND-ed. Mentioning `is:bot`, `is:datacenter` or `is:abusive` (negated or not)
 * takes over from the default that hides those clicks.
 */

import { SEARCH_FLAGS } from '../shared/search.ts';
import { BadQueryError } from './errors.ts';

type Param = string | number;

export interface Condition {
    sql: string;
    params: Param[];
}

/** Defaults a search can take over (see `whereClause`). */
export type SearchOverride = 'bots' | 'dc' | 'abusive';

export interface CompiledSearch {
    condition: Condition | null;
    overrides: Set<SearchOverride>;
}

/** Text fields: `name:value` matches when any of the columns contains the value. */
const TEXT_FIELDS: Record<string, readonly string[]> = {
    ip: ['c.ip'],
    isp: ['c.isp'],
    host: ['c.hostname'],
    country: ['c.country'],
    region: ['c.region'],
    city: ['c.city'],
    referrer: ['c.referrer', 'c.referrer_host'],
    source: ['c.source'],
    os: ['c.os'],
    browser: ['c.browser'],
    device: ['c.device', 'c.device_model'],
    model: ['c.device_model'],
    ua: ['c.user_agent'],
    bot: ['c.bot_name'],
    lang: ['c.language'],
    tz: ['c.timezone'],
    fp: ['c.fingerprint'],
    gpu: ['c.gpu'],
    platform: ['c.platform'],
    screen: ['c.screen'],
    orientation: ['c.orientation'],
    connection: ['c.connection'],
    utm_source: ['c.utm_source'],
    utm_medium: ['c.utm_medium'],
    utm_campaign: ['c.utm_campaign'],
    utm_term: ['c.utm_term'],
    utm_content: ['c.utm_content'],
    utm: ['c.utm_source', 'c.utm_medium', 'c.utm_campaign', 'c.utm_term', 'c.utm_content'],
    query: ['c.query']
};

const NUMBER_FIELDS: Record<string, string> = {
    ram: 'c.memory',
    battery: 'c.battery',
    abuse: 'c.abuse_score',
    touch: 'c.touch_points',
    lat: 'c.latitude',
    lon: 'c.longitude'
};

const ALIASES: Record<string, string> = {
    hostname: 'host',
    ref: 'referrer',
    useragent: 'ua',
    language: 'lang',
    timezone: 'tz',
    fingerprint: 'fp',
    memory: 'ram',
    param: 'query',
    slug: 'link',
    score: 'abuse',
    datacenter: 'dc',
    reported: 'abusive',
    incognito: 'private',
    adblocker: 'adblock'
};

/** Every column free text is matched against. */
const ALL_TEXT = [...new Set(Object.values(TEXT_FIELDS).flat())];
const SLUG_LIKE = String.raw`c.link_id IN (SELECT id FROM links WHERE slug LIKE ? ESCAPE '\')`;
const SLUG_IS = 'c.link_id IN (SELECT id FROM links WHERE slug = ? COLLATE NOCASE)';

const MAX_TERMS = 32;
const MAX_LENGTH = 1000;

interface Term {
    negate: boolean;
    field: string | null;
    value: string;
}

/** Splits on whitespace, keeping "quoted phrases" (also as `field:"a value"`) together. */
export function tokenize(q: string): Term[] {
    const terms: Term[] = [];
    const re = /(-?)(?:([a-z_]+):)?(=?)(?:"([^"]*)"?|(\S+))/gi;
    for (const m of q.matchAll(re)) {
        const [, minus, field, eq, quoted, bare] = m;
        const value = eq + (quoted ?? bare ?? '');
        if (!field && value === '') continue;
        // A URL ("https://…") or IPv6 address ("abcd:ef01::1") is text, not a field.
        if (field && bare !== undefined && looksLikeText(field, bare)) {
            terms.push({ negate: minus === '-', field: null, value: `${field}:${eq}${bare}` });
            continue;
        }
        terms.push({
            negate: minus === '-',
            field: field ? field.toLowerCase() : null,
            value
        });
    }
    return terms;
}

function looksLikeText(field: string, value: string): boolean {
    return value.startsWith('//') || (/^[\da-f]{1,4}$/i.test(field) && /^[\da-f:.]*$/i.test(value));
}

/** `%value%` for LIKE … ESCAPE '\', with the value's own wildcards made literal. */
export function likePattern(value: string): string {
    return `%${value.replaceAll(/[\\%_]/g, ch => `\\${ch}`)}%`;
}

function containsAny(columns: readonly string[], value: string): Condition {
    const pattern = likePattern(value);
    return {
        sql: `(${columns.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
        params: columns.map(() => pattern)
    };
}

/** `=value`: the column is exactly the value, ignoring case. */
function equalsAny(columns: readonly string[], value: string): Condition {
    return {
        sql: `(${columns.map(c => `${c} = ? COLLATE NOCASE`).join(' OR ')})`,
        params: columns.map(() => value)
    };
}

function present(column: string): string {
    return `(${column} IS NOT NULL AND ${column} != '')`;
}

const COMPARE_RE = /^(>=|<=|>|<|=)?(-?\d+(?:\.\d+)?)$/;

function numberCondition(name: string, column: string, value: string): Condition {
    const m = COMPARE_RE.exec(value);
    if (!m) throw new BadQueryError(`${name}: expects a number, e.g. ${name}:>=8`);
    return { sql: `${column} ${m[1] ?? '='} ?`, params: [Number(m[2])] };
}

function flagCondition(
    name: string,
    abuseMinScore: number,
    overrides: Set<SearchOverride>
): Condition {
    switch (name) {
        case 'bot':
            overrides.add('bots');
            return { sql: 'c.is_bot = 1', params: [] };
        case 'dc':
            overrides.add('dc');
            return { sql: 'c.is_datacenter = 1', params: [] };
        case 'abusive':
            overrides.add('abusive');
            return { sql: 'c.abuse_score >= ?', params: [abuseMinScore] };
        case 'private':
            return { sql: 'c.incognito = 1', params: [] };
        case 'adblock':
            return { sql: 'c.ad_blocker = 1', params: [] };
        case 'charging':
            return { sql: 'c.charging = 1', params: [] };
        case 'qr':
            return { sql: 'c.via_qr = 1', params: [] };
        case 'touch':
            return { sql: 'c.touch_points > 0', params: [] };
        case 'mobile':
        case 'desktop':
        case 'tablet':
            return { sql: 'c.device = ?', params: [name] };
        default:
            throw new BadQueryError(
                `Unknown flag is:${name}. Try ${SEARCH_FLAGS.map(f => f.name).join(', ')}`
            );
    }
}

function termCondition(
    term: Term,
    abuseMinScore: number,
    overrides: Set<SearchOverride>
): Condition {
    if (term.field === null) {
        // Every text column, plus the link's slug.
        const text = containsAny(ALL_TEXT, term.value);
        return {
            sql: `(${text.sql} OR ${SLUG_LIKE})`,
            params: [...text.params, likePattern(term.value)]
        };
    }
    const name = ALIASES[term.field] ?? term.field;
    const value = ALIASES[term.value.toLowerCase()] ?? term.value.toLowerCase();

    if (name === 'is') return flagCondition(value, abuseMinScore, overrides);
    if (name === 'has') {
        const columns = TEXT_FIELDS[value] ?? (NUMBER_FIELDS[value] && [NUMBER_FIELDS[value]]);
        if (!columns) throw new BadQueryError(`Unknown field has:${term.value}`);
        return { sql: `(${columns.map(c => present(c)).join(' OR ')})`, params: [] };
    }
    if (term.value === '' || term.value === '=') {
        throw new BadQueryError(`${term.field}: needs a value`);
    }
    const exact = term.value.startsWith('=') ? term.value.slice(1) : null;
    if (name === 'link') {
        // The root link's slug is empty; it's shown as "/".
        if (exact !== null) return { sql: SLUG_IS, params: [exact === '/' ? '' : exact] };
        return { sql: SLUG_LIKE, params: [likePattern(term.value)] };
    }
    const text = TEXT_FIELDS[name];
    if (text) return exact === null ? containsAny(text, term.value) : equalsAny(text, exact);
    const number = NUMBER_FIELDS[name];
    if (number) return numberCondition(name, number, term.value);
    throw new BadQueryError(`Unknown search field: ${term.field}`);
}

/** Compiles a search into one SQL condition over `clicks c`. */
export function compileSearch(q: string, abuseMinScore: number): CompiledSearch {
    const overrides = new Set<SearchOverride>();
    if (q.length > MAX_LENGTH) throw new BadQueryError('Search is too long');
    const terms = tokenize(q);
    if (terms.length > MAX_TERMS)
        throw new BadQueryError(`Search has too many terms (max ${MAX_TERMS})`);
    if (terms.length === 0) return { condition: null, overrides };
    const parts = terms.map(term => {
        const c = termCondition(term, abuseMinScore, overrides);
        // NOT over NULL is NULL, so a negated term keeps clicks where the field is missing.
        return term.negate ? { sql: `NOT COALESCE(${c.sql}, 0)`, params: c.params } : c;
    });
    return {
        condition: {
            sql: parts.map(p => p.sql).join(' AND '),
            params: parts.flatMap(p => p.params)
        },
        overrides
    };
}

/** Fields whose suggestions come from a different column than the first one they search. */
const SUGGEST_COLUMNS: Record<string, string> = {
    link: 'l.slug',
    referrer: 'c.referrer_host'
};

/**
 * The column to suggest values for `field:` from (`l` is the joined link), or null when
 * the field has no single column (`utm`) or isn't a field.
 */
export function suggestColumn(field: string): string | null {
    const name = ALIASES[field] ?? field;
    if (name === 'utm') return null;
    return SUGGEST_COLUMNS[name] ?? TEXT_FIELDS[name]?.[0] ?? NUMBER_FIELDS[name] ?? null;
}
