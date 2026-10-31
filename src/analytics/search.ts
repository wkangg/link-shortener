/**
 * Click search: a small query language over every stored click property.
 *
 *   firefox                  any text field contains "firefox"
 *   "san francisco"          quoted phrase
 *   isp:comcast ip:203.0.    a field contains the value
 *   ip:=203.0.113.5          a field is exactly the value (case-insensitive)
 *   ram:>=8 battery:<20      numeric comparisons (=, >, >=, <, <=)
 *   is:bot is:datacenter     flags (also is:vpn, is:scraper, is:abusive, is:qr, ...)
 *   has:gpu                  the field is set
 *   query.ref:=twitter       a query parameter (`?ref=twitter`)
 *   -os:windows -is:bot      a leading `-` negates any term
 *   os:ios os:android        the same field twice: either (see `implicitRun`)
 *   os:ios || isp:rogers     either side matches
 *   os:ios && os:android     both, even on the same field
 *   (a || b) c, -(a b)       brackets group
 *
 * Other terms are AND-ed, and AND binds tighter than `||`. Mentioning `is:bot`,
 * `is:datacenter`, `is:scraper`, `is:vpn` or `is:abusive` (negated or not) takes over
 * from the default that hides or shows them.
 */

import { SEARCH_FLAGS } from '../shared/search.ts';
import { BadQueryError } from './errors.ts';

type Param = string | number;

export interface Condition {
    sql: string;
    params: Param[];
}

/** Defaults a search can take over (see `whereClause`). */
export type SearchOverride = 'bots' | 'dc' | 'abusive' | 'scrapers' | 'vpn';

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
    os: ['c.os', 'c.os_version'],
    browser: ['c.browser'],
    device: ['c.device', 'c.device_model'],
    model: ['c.device_model'],
    ua: ['c.user_agent'],
    bot: ['c.bot_name'],
    vpn: ['c.vpn'],
    scraper: ['c.scraper'],
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
    cores: 'c.cpu_cores',
    battery: 'c.battery',
    abuse: 'c.abuse_score',
    touch: 'c.touch_points',
    lat: 'c.latitude',
    lon: 'c.longitude'
};

/** Other names for click search fields and flags. */
export const ALIASES: Record<string, string> = {
    hostname: 'host',
    ref: 'referrer',
    useragent: 'ua',
    language: 'lang',
    timezone: 'tz',
    fingerprint: 'fp',
    memory: 'ram',
    cpu: 'cores',
    param: 'query',
    slug: 'link',
    score: 'abuse',
    datacenter: 'dc',
    scrapers: 'scraper',
    relay: 'vpn',
    reported: 'abusive',
    incognito: 'private',
    adblocker: 'adblock'
};

/** A field name: a plain one, or `query.<key>` for one query parameter. */
const FIELD = String.raw`(?:query|param)\.[\w.~-]+|[a-z_]+`;
const UNFINISHED_RE = new RegExp(String.raw`^(?:${FIELD}):=?$`, 'i');
const MAX_PARAM_KEY = 64;

/** Every column free text is matched against. */
const ALL_TEXT = [...new Set(Object.values(TEXT_FIELDS).flat())];
const SLUG_LIKE = String.raw`c.link_id IN (SELECT id FROM links WHERE slug LIKE ? ESCAPE '\')`;
const SLUG_IS = 'c.link_id IN (SELECT id FROM links WHERE slug = ? COLLATE NOCASE)';

const MAX_TERMS = 32;
const MAX_LENGTH = 1000;
const MAX_DEPTH = 8;

export interface Term {
    negate: boolean;
    field: string | null;
    value: string;
}

/** `-(` opens a negated group. */
interface Operator {
    op: '(' | '-(' | ')' | '||' | '&&';
}

type Token = Term | Operator;

/**
 * Operators, then terms. A bare value runs until whitespace, a bracket, `||` or `&&`;
 * quote it ("a (b)") to keep those, with `\"` and `\\` for a quote or backslash inside.
 */
const TOKEN_RE = new RegExp(
    String.raw`(\|\||&&|-?\(|\))|(-?)(?:(${FIELD}):)?(=?)(?:"((?:[^"\\]|\\[\s\S]?)*)("?)|((?:[^\s()|&]|\|(?!\|)|&(?!&))+))`,
    'gi'
);

/**
 * Splits into terms and operators, keeping "quoted phrases" (also as `field:"a value"`)
 * together. `field:""` is an empty value; `field:"` with nothing after it yet is skipped.
 */
export function tokenize(q: string): Token[] {
    const tokens: Token[] = [];
    for (const m of q.matchAll(TOKEN_RE)) {
        const [, op, minus, field, eq, quoted, closed, bare] = m;
        if (op) {
            tokens.push({ op: op as Operator['op'] });
            continue;
        }
        if (quoted === '' && !closed) continue;
        const value = eq + (quoted?.replaceAll(/\\(["\\])/g, '$1') ?? bare ?? '');
        if (!field && value === '') continue;
        // A URL ("https://…") or IPv6 address ("abcd:ef01::1") is text, not a field.
        if (field && bare !== undefined && looksLikeText(field, bare)) {
            tokens.push({ negate: minus === '-', field: null, value: `${field}:${eq}${bare}` });
            continue;
        }
        tokens.push({
            negate: minus === '-',
            // Query parameter keys keep their case: `?Ref=` isn't `?ref=`.
            field: field ? field.replace(/^[^.]*/, name => name.toLowerCase()) : null,
            value
        });
    }
    return tokens;
}

export type SearchNode =
    | { kind: 'term'; term: Term }
    | { kind: 'and' | 'or'; nodes: SearchNode[] }
    | { kind: 'not'; node: SearchNode };

function isOp(token: Token | undefined, op: Operator['op']): boolean {
    return token !== undefined && 'op' in token && token.op === op;
}

function joined(kind: 'and' | 'or', nodes: SearchNode[]): SearchNode | null {
    return nodes.length > 1 ? { kind, nodes } : (nodes[0] ?? null);
}

/** How a search's fields read: what `parseSearch` needs to group terms like the compiler. */
export interface SearchDialect {
    /** Other names for fields, mapped to their usual name. */
    aliases?: Record<string, string>;
    /** Numeric fields (by usual name), where `<` and `>` start a comparison. */
    ranges?: ReadonlySet<string>;
    /**
     * Known fields (by usual name), for a search that reads other `name:value` terms as
     * text rather than rejecting them: those stay AND-ed like text.
     */
    fields?: ReadonlySet<string>;
}

/**
 * What a term is OR-ed with when only spaces separate them: terms on the same known
 * field (`country:=CA country:=US`), aliases included. Null for terms that are always
 * AND-ed: free text, negations (`-os:a -os:b` excludes both), ranges on numeric fields
 * (`ram:>=4 ram:<16`), and `is:`/`has:`, whose flags are independent.
 */
function implicitKey(term: Term, { aliases = {}, ranges, fields }: SearchDialect): string | null {
    if (term.field === null || term.negate) return null;
    // `param.ref` is `query.ref`.
    const field = term.field.replace(/^param\./, 'query.');
    if (field === 'is' || field === 'has') return null;
    const name = aliases[field] ?? field;
    if (fields && !fields.has(name)) return null;
    if (ranges?.has(name) && /^[<>]/.test(term.value)) return null;
    return name;
}

/** A space-separated item, with its `implicitKey` (null for a bracketed group). */
interface RunItem {
    node: SearchNode;
    key: string | null;
}

/** Space-separated items: those with the same key OR-ed, then everything AND-ed. */
function implicitRun(items: RunItem[]): SearchNode | null {
    const groups: SearchNode[][] = [];
    const byKey = new Map<string, SearchNode[]>();
    for (const { node, key } of items) {
        const same = key === null ? undefined : byKey.get(key);
        if (same) same.push(node);
        else {
            const group = [node];
            groups.push(group);
            if (key !== null) byKey.set(key, group);
        }
    }
    return joined(
        'and',
        groups.map(group => joined('or', group)).filter(node => node !== null)
    );
}

/**
 * Parses a search into a tree, or null when it has no finished terms. Lenient while
 * typing: unfinished terms, a dangling `||` or `&&` and an unclosed `(` are ignored.
 */
export function parseSearch(q: string, dialect: SearchDialect = {}): SearchNode | null {
    if (q.length > MAX_LENGTH) throw new BadQueryError('Search is too long');
    const tokens = tokenize(q);
    if (tokens.filter(t => !('op' in t)).length > MAX_TERMS)
        throw new BadQueryError(`Search has too many terms (max ${MAX_TERMS})`);
    let i = 0;

    // Space-separated runs, AND-ed by `&&` into chains, the chains OR-ed by `||`;
    // stops before a `)`.
    const group = (depth: number): SearchNode | null => {
        if (depth > MAX_DEPTH) throw new BadQueryError('Search has too many nested brackets');
        const either: SearchNode[] = [];
        let chain: SearchNode[] = [];
        let run: RunItem[] = [];
        const endRun = () => {
            const node = implicitRun(run);
            if (node) chain.push(node);
            run = [];
        };
        const endChain = () => {
            endRun();
            const node = joined('and', chain);
            if (node) either.push(node);
            chain = [];
        };
        for (let token = tokens[i]; token && !isOp(token, ')'); token = tokens[i]) {
            i++;
            if (!('op' in token)) {
                if (!isUnfinished(token)) {
                    run.push({
                        node: { kind: 'term', term: token },
                        key: implicitKey(token, dialect)
                    });
                }
            } else if (token.op === '&&') endRun();
            else if (token.op === '||') endChain();
            else if (token.op === '(' || token.op === '-(') {
                const inner = group(depth + 1);
                if (isOp(tokens[i], ')')) i++;
                const node: SearchNode | null =
                    inner && token.op === '-(' ? { kind: 'not', node: inner } : inner;
                if (node) run.push({ node, key: null });
            }
        }
        endChain();
        return joined('or', either);
    };

    const tree = group(0);
    if (i < tokens.length) throw new BadQueryError('Search has a ) without a (');
    return tree;
}

/** A value as typed: quoted (quotes and backslashes escaped) when a bare value couldn't hold it. */
export function quoteValue(value: string): string {
    return value === '' || /[\s"()|&]/.test(value)
        ? `"${value.replaceAll(/["\\]/g, String.raw`\$&`)}"`
        : value;
}

/** A term as it would be typed. */
function termText({ field, value }: Term): string {
    const eq = value.startsWith('=') ? '=' : '';
    return `${field ? `${field}:` : ''}${eq}${quoteValue(value.slice(eq.length))}`;
}

/**
 * How a parsed search reads, with AND, OR and NOT spelled out and every group
 * bracketed: `country:=CA country:=US is:qr` is `(country:=CA OR country:=US) AND is:qr`.
 */
export function describeSearch(node: SearchNode, nested = false): string {
    if (node.kind === 'term')
        return node.term.negate ? `NOT ${termText(node.term)}` : termText(node.term);
    if (node.kind === 'not') return `NOT ${describeSearch(node.node, true)}`;
    const text = node.nodes
        .map(n => describeSearch(n, true))
        .join(node.kind === 'and' ? ' AND ' : ' OR ');
    return nested ? `(${text})` : text;
}

/** How the click search's fields read. */
export const CLICK_DIALECT: SearchDialect = {
    aliases: ALIASES,
    ranges: new Set(Object.keys(NUMBER_FIELDS))
};

/** NOT over NULL is NULL, so a negation keeps rows where the field is missing. */
function not(c: Condition): Condition {
    return { sql: `NOT COALESCE(${c.sql}, 0)`, params: c.params };
}

/** One SQL condition for a parsed search, compiling each term with `compileTerm`. */
export function compileTree(node: SearchNode, compileTerm: (term: Term) => Condition): Condition {
    if (node.kind === 'term') {
        const c = compileTerm(node.term);
        return node.term.negate ? not(c) : c;
    }
    if (node.kind === 'not') return not(compileTree(node.node, compileTerm));
    const parts = node.nodes.map(n => compileTree(n, compileTerm));
    return {
        sql: `(${parts.map(p => p.sql).join(node.kind === 'and' ? ' AND ' : ' OR ')})`,
        params: parts.flatMap(p => p.params)
    };
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
        case 'scraper':
            overrides.add('scrapers');
            return { sql: 'c.scraper IS NOT NULL', params: [] };
        case 'vpn':
            overrides.add('vpn');
            return { sql: 'c.vpn IS NOT NULL', params: [] };
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

/** `query.<key>:value`: the click's `?key=` contains the value, or is it with `=`. */
function paramCondition(key: string, value: string): Condition {
    if (key.length > MAX_PARAM_KEY) throw new BadQueryError('Query parameter name is too long');
    const path = `$."${key}"`;
    return value.startsWith('=')
        ? { sql: 'json_extract(c.query, ?) = ? COLLATE NOCASE', params: [path, value.slice(1)] }
        : {
              sql: String.raw`json_extract(c.query, ?) LIKE ? ESCAPE '\'`,
              params: [path, likePattern(value)]
          };
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
    const dot = term.field.indexOf('.');
    if (dot !== -1) return paramCondition(term.field.slice(dot + 1), term.value);
    const name = ALIASES[term.field] ?? term.field;
    const value = ALIASES[term.value.toLowerCase()] ?? term.value.toLowerCase();

    if (name === 'is') return flagCondition(value, abuseMinScore, overrides);
    if (name === 'has') {
        const columns = TEXT_FIELDS[value] ?? (NUMBER_FIELDS[value] && [NUMBER_FIELDS[value]]);
        if (!columns) throw new BadQueryError(`Unknown field has:${term.value}`);
        return { sql: `(${columns.map(c => present(c)).join(' OR ')})`, params: [] };
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

/**
 * A field with nothing after it yet (`ip:`, `ip:=`), so results filter as you type.
 * The tokenizer reads these as text, and skips `ip:"`; `ip:=""` is an empty value.
 */
function isUnfinished(term: Term): boolean {
    return term.field === null && UNFINISHED_RE.test(term.value);
}

/** Compiles a search into one SQL condition over `clicks c`. */
export function compileSearch(q: string, abuseMinScore: number): CompiledSearch {
    const overrides = new Set<SearchOverride>();
    const tree = parseSearch(q, CLICK_DIALECT);
    const condition =
        tree && compileTree(tree, term => termCondition(term, abuseMinScore, overrides));
    return { condition, overrides };
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
