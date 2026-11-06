import { beforeAll, describe, expect, test } from 'bun:test';

import {
    CLICK_DIALECT,
    compileSearch,
    describeSearch,
    parseSearch,
    quoteValue,
    tokenize
} from '../src/analytics/search.ts';
import { BadQueryError, Stats } from '../src/analytics/stats.ts';
import {
    hasTerm,
    termAt,
    toggleTerm,
    withTerm
} from '../src/dashboard/client/components/SearchBox.tsx';
import { openDatabase } from '../src/db/client.ts';
import { LINK_SEARCH_DIALECT, SEARCH_FIELDS, SEARCH_FLAGS } from '../src/shared/search.ts';
import type { StatsQuery } from '../src/shared/types.ts';

const T = Date.UTC(2026, 9, 10);
const HOUR = 3_600_000;
const db = openDatabase(':memory:');
const stats = new Stats(db);

beforeAll(() => {
    db.run(
        "INSERT INTO links (id, slug, url, created_at, updated_at) VALUES (1, 'launch', 'https://a.com', 0, 0), (2, 'docs', 'https://b.com', 0, 0)"
    );
    const insert = db.query(
        `INSERT INTO clicks (link_id, ts, ip, isp, os, browser, device, city, memory, battery,
                             is_bot, is_datacenter, abuse_score, incognito, gpu, source, visitor_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // prettier-ignore
    const rows: (string | number | null)[][] = [
        [1, T + HOUR, '203.0.113.5', 'Comcast Cable', 'Windows', 'Firefox', 'desktop', 'New York', 8, null, 0, 0, 0, 0, 'NVIDIA GeForce', 'Direct', 'v1'],
        [1, T + 2 * HOUR, '198.51.100.7', 'Rogers', 'iOS', 'Safari', 'mobile', 'Toronto', 4, 15, 0, 0, null, 1, null, 'X', 'v2'],
        [2, T + 3 * HOUR, '2001:db8::1', 'Example Cloud', 'Linux', 'Chrome', 'desktop', null, 16, null, 0, 1, 0, 0, null, 'Direct', 'v3'],
        [2, T + 4 * HOUR, '192.0.2.9', 'Shady Broadband', 'Windows', 'Chrome', 'desktop', null, null, null, 0, 0, 90, 0, null, 'Direct', 'v4'],
        [1, T + 5 * HOUR, '192.0.2.10', null, null, null, null, null, null, null, 1, 0, null, null, null, 'Direct', 'v5'],
    ];
    for (const row of rows) insert.run(...row);
});

const q = (search: string, overrides: Partial<StatsQuery> = {}): StatsQuery => ({
    from: T,
    to: T + 24 * HOUR,
    tz: 0,
    filters: [],
    q: search,
    ...overrides
});
const ips = (search: string, overrides?: Partial<StatsQuery>) =>
    stats
        .history(q(search, overrides))
        .clicks.map(c => c.ip)
        .toSorted();

describe('tokenize', () => {
    test('fields, phrases, negation, URLs and IPv6', () => {
        expect(tokenize('firefox -os:windows city:"new york" ram:>=8')).toEqual([
            { negate: false, field: null, value: 'firefox' },
            { negate: true, field: 'os', value: 'windows' },
            { negate: false, field: 'city', value: 'new york' },
            { negate: false, field: 'ram', value: '>=8' }
        ]);
        expect(tokenize('isp:="Comcast Cable" ram:=8')).toEqual([
            { negate: false, field: 'isp', value: '=Comcast Cable' },
            { negate: false, field: 'ram', value: '=8' }
        ]);
        expect(tokenize('https://t.co/x 2001:db8::1 abcd:ef01::2')).toEqual([
            { negate: false, field: null, value: 'https://t.co/x' },
            { negate: false, field: null, value: '2001:db8::1' },
            { negate: false, field: null, value: 'abcd:ef01::2' }
        ]);
    });
});

describe('search', () => {
    test('free text matches any text field, case-insensitively', () => {
        expect(ips('comcast')).toEqual(['203.0.113.5']);
        expect(ips('CHROME')).toEqual([]); // the Chrome clicks are datacenter / abusive
        expect(ips('"new york"')).toEqual(['203.0.113.5']);
        expect(ips('launc')).toEqual(['198.51.100.7', '203.0.113.5']);
        expect(ips('2001:db8', { dc: true })).toEqual(['2001:db8::1']);
    });

    test('field values, numbers and negation', () => {
        expect(ips('ip:198.51')).toEqual(['198.51.100.7']);
        expect(ips('isp:rogers')).toEqual(['198.51.100.7']);
        expect(ips('ram:>=8')).toEqual(['203.0.113.5']);
        expect(ips('ram:4')).toEqual(['198.51.100.7']);
        db.run("UPDATE clicks SET cpu_cores = 12 WHERE ip = '203.0.113.5'");
        expect(ips('cores:>=8')).toEqual(['203.0.113.5']);
        expect(ips('cpu:12')).toEqual(['203.0.113.5']);
        expect(ips('battery:<20')).toEqual(['198.51.100.7']);
        expect(ips('-os:windows')).toEqual(['198.51.100.7']);
        expect(ips('link:launch')).toEqual(['198.51.100.7', '203.0.113.5']);
        expect(ips('has:gpu')).toEqual(['203.0.113.5']);
        expect(ips('ip:=203.0.113')).toEqual([]);
        expect(ips('ip:=203.0.113.5')).toEqual(['203.0.113.5']);
        expect(ips('isp:="comcast cable"')).toEqual(['203.0.113.5']);
        expect(ips('link:=LAUNCH')).toEqual(['198.51.100.7', '203.0.113.5']);
        expect(ips('ip:=2001:db8::1', { dc: true })).toEqual(['2001:db8::1']);
        expect(ips('is:private')).toEqual(['198.51.100.7']);
        expect(ips('is:mobile')).toEqual(['198.51.100.7']);
    });

    test('query.<key>: matches one query parameter, keeping the key’s case', () => {
        db.run(
            `UPDATE clicks SET query = '{"ref":"twitter ads","Ref":"x"}' WHERE ip = '198.51.100.7'`
        );
        expect(tokenize('-Query.Ref:=x')).toEqual([
            { negate: true, field: 'query.Ref', value: '=x' }
        ]);
        expect(ips('query.ref:twitter')).toEqual(['198.51.100.7']);
        expect(ips('query.ref:="TWITTER ADS"')).toEqual(['198.51.100.7']);
        expect(ips('query.ref:=twitter')).toEqual([]);
        expect(ips('param.Ref:=x')).toEqual(['198.51.100.7']);
        expect(ips('-query.ref:twitter')).toEqual(['203.0.113.5']);
        expect(ips('example.com:8080')).toEqual([]); // still free text
    });

    test('|| and && with brackets', () => {
        expect(tokenize('-(os:ios||a&&b) "x (y)"')).toEqual([
            { op: '-(' },
            { negate: false, field: 'os', value: 'ios' },
            { op: '||' },
            { negate: false, field: null, value: 'a' },
            { op: '&&' },
            { negate: false, field: null, value: 'b' },
            { op: ')' },
            { negate: false, field: null, value: 'x (y)' }
        ]);
        expect(ips('os:windows || os:ios')).toEqual(['198.51.100.7', '203.0.113.5']);
        expect(ips('os:windows && os:ios')).toEqual([]);
        // AND binds tighter: windows, or (ios and comcast).
        expect(ips('os:windows || os:ios isp:comcast')).toEqual(['203.0.113.5']);
        expect(ips('(os:windows || os:ios) && isp:rogers')).toEqual(['198.51.100.7']);
        expect(ips('-(os:windows || isp:comcast)')).toEqual(['198.51.100.7']);
        expect(ips('-(os:ios is:mobile)')).toEqual(['203.0.113.5']);
        expect(ips('((os:ios))')).toEqual(['198.51.100.7']);
        expect(ips('is:bot || os:ios')).toEqual(['192.0.2.10', '198.51.100.7']);
    });

    test('with only spaces, the same field twice is either; other terms are both', () => {
        expect(ips('os:windows os:ios')).toEqual(['198.51.100.7', '203.0.113.5']);
        expect(ips('os:windows OS:ios isp:rogers')).toEqual(['198.51.100.7']);
        // Aliases are the same field.
        expect(ips('memory:8 ram:4')).toEqual(['198.51.100.7', '203.0.113.5']);
        // && keeps both; so do ranges, negations, flags and free text.
        expect(ips('os:windows && os:ios')).toEqual([]);
        expect(ips('ram:>=4 ram:<8')).toEqual(['198.51.100.7']);
        expect(ips('-os:windows -os:ios')).toEqual([]);
        expect(ips('is:mobile is:private')).toEqual(['198.51.100.7']);
        expect(ips('is:mobile has:gpu')).toEqual([]);
        expect(ips('firefox safari')).toEqual([]);
        // Grouping happens within the brackets, not across them.
        expect(ips('(os:windows) os:ios')).toEqual([]);
        expect(ips('os:windows os:ios && isp:rogers')).toEqual(['198.51.100.7']);
    });

    test('|| and brackets are lenient while typing', () => {
        expect(ips('os:ios &&')).toEqual(['198.51.100.7']);
        expect(ips('os:ios ||')).toEqual(['198.51.100.7']);
        expect(ips('os:ios || os:')).toEqual(['198.51.100.7']);
        expect(ips('(os:ios || os:windows')).toEqual(['198.51.100.7', '203.0.113.5']);
        expect(ips('() os:ios')).toEqual(['198.51.100.7']);
        expect(() => stats.history(q('os:ios)'))).toThrow(BadQueryError);
        expect(() => stats.history(q(`${'('.repeat(20)}os:ios`))).toThrow(BadQueryError);
    });

    test('a field with nothing after it yet filters nothing', () => {
        expect(ips('ip:')).toEqual(ips(''));
        expect(ips('query.ref:')).toEqual(ips(''));
        expect(ips('-ip:= is:')).toEqual(ips(''));
        expect(ips('isp:rogers has:')).toEqual(['198.51.100.7']);
    });

    test('LIKE wildcards in the value are literal', () => {
        expect(ips('%')).toEqual([]);
        expect(ips('isp:_')).toEqual([]);
    });

    test('is:bot, is:datacenter and is:abusive take over from the hiding defaults', () => {
        expect(ips('is:bot')).toEqual(['192.0.2.10']);
        expect(ips('is:datacenter')).toEqual(['2001:db8::1']);
        expect(ips('is:abusive')).toEqual(['192.0.2.9']);
        expect(ips('is:reported')).toEqual(['192.0.2.9']); // old name still works
        expect(ips('-is:bot')).toEqual(['198.51.100.7', '203.0.113.5']);
        expect(ips('-is:abusive', { bots: true, dc: true })).toHaveLength(4);
    });

    test('applies to summaries too', () => {
        expect(stats.summary(q('os:windows')).clicks).toBe(1);
    });

    test('bad searches are 400s, not crashes', () => {
        expect(() => stats.history(q('colour:red'))).toThrow(BadQueryError);
        expect(() => stats.history(q('ram:lots'))).toThrow(BadQueryError);
        expect(() => stats.history(q('is:nonsense'))).toThrow(BadQueryError);
        expect(() => stats.history(q('x '.repeat(40)))).toThrow(BadQueryError);
    });
});

describe('autocomplete', () => {
    test('every listed field and flag is one the search understands', () => {
        for (const { name } of SEARCH_FIELDS) {
            const term = name === 'is' ? 'is:bot' : name === 'has' ? 'has:gpu' : `${name}:1`;
            expect(() => compileSearch(term, 25)).not.toThrow();
        }
        for (const { name } of SEARCH_FLAGS) {
            expect(() => compileSearch(`is:${name}`, 25)).not.toThrow();
        }
    });

    test('suggests common values containing the text, ignoring the current search', () => {
        expect(stats.suggest(q('isp:zzz'), 'isp', 'o').values).toEqual([
            { value: 'Comcast Cable', clicks: 1 },
            { value: 'Rogers', clicks: 1 }
        ]);
        expect(stats.suggest(q(''), 'link', '').values).toEqual([{ value: 'launch', clicks: 2 }]);
        expect(stats.suggest(q('', { dc: true }), 'ram', '').values.map(v => v.value)).toEqual([
            '16',
            '4',
            '8'
        ]);
        expect(() => stats.suggest(q(''), 'utm', '')).toThrow(BadQueryError);
    });
});

function described(q: string): string | null {
    const tree = parseSearch(q, CLICK_DIALECT);
    return tree && describeSearch(tree);
}

describe('describeSearch', () => {
    test('spells out how terms combine', () => {
        expect(described('country:=CA country:=US is:qr')).toBe(
            '(country:=CA OR country:=US) AND is:qr'
        );
        expect(described('ref:x referrer:y')).toBe('ref:x OR referrer:y');
        expect(described('a b || c')).toBe('(a AND b) OR c');
        expect(described('-os:windows -(is:bot || is:dc)')).toBe(
            'NOT os:windows AND NOT (is:bot OR is:dc)'
        );
        expect(described('"san francisco" ip:')).toBe('"san francisco"');
        expect(described('')).toBeNull();
    });
});

describe('same-field OR edge cases', () => {
    test('param.<key> and query.<key> are the same field', () => {
        expect(described('query.ref:a param.ref:b')).toBe('query.ref:a OR param.ref:b');
    });

    test('< and > only make a range on numeric fields', () => {
        expect(described('ram:>=4 ram:<8')).toBe('ram:>=4 AND ram:<8');
        expect(described('os:>a os:<b')).toBe('os:>a OR os:<b');
        expect(parseSearch('title:>draft title:<release', LINK_SEARCH_DIALECT)?.kind).toBe('or');
    });

    test('quotes and backslashes survive a round trip', () => {
        const value = String.raw`say "hi" C:\ `;
        const [term] = tokenize(`ua:=${quoteValue(value)}`);
        expect(term).toEqual({ negate: false, field: 'ua', value: `=${value}` });
        expect(tokenize(String.raw`"a\b"`)).toEqual([
            { negate: false, field: null, value: String.raw`a\b` }
        ]);
    });
});

describe('second review', () => {
    test('field:"" is an exact empty value; field:" is still being typed', () => {
        expect(tokenize('query.ref:=""')).toEqual([
            { negate: false, field: 'query.ref', value: '=' }
        ]);
        expect(tokenize('os:"')).toEqual([]);
        expect(described('query.ref:="" is:qr')).toBe('query.ref:="" AND is:qr');
    });

    test('unknown links fields stay AND-ed', () => {
        expect(parseSearch('color:red color:blue', LINK_SEARCH_DIALECT)?.kind).toBe('and');
        expect(parseSearch('tag:a tag:b', LINK_SEARCH_DIALECT)?.kind).toBe('or');
    });

    test('a clicked term goes after open brackets', () => {
        expect(withTerm('-(is:bot', 'country:=CA')).toBe('-(is:bot) country:=CA');
        expect(withTerm('(a || (b', 'c')).toBe('((a || (b))) c');
        expect(withTerm('os:"a (b"', 'c')).toBe('os:"a (b" c');
    });

    test('clicking a row again removes its term', () => {
        expect(toggleTerm('', 'country:=CA')).toBe('country:=CA');
        expect(toggleTerm('country:=CA', 'country:=CA')).toBe('');
        expect(toggleTerm('is:qr country:=CA os:=iOS', 'country:=CA')).toBe('is:qr os:=iOS');
        expect(toggleTerm('city:="New York" is:qr', 'city:="New York"')).toBe('is:qr');
        // A negated or longer term isn't the same filter.
        expect(toggleTerm('-country:=CA', 'country:=CA')).toBe('-country:=CA country:=CA');
        expect(toggleTerm('country:=CAN', 'country:=CA')).toBe('country:=CAN country:=CA');
        expect(hasTerm('is:qr country:=CA', 'country:=CA')).toBe(true);
        // Only top-level AND-ed terms come out: not one inside brackets or quotes, or
        // beside a top-level || or && (which would be left dangling). `withTerm` then
        // leaves the search alone, as before, since the term is already in it.
        expect(toggleTerm('is:qr || (a country:=CA b)', 'country:=CA')).toBe(
            'is:qr || (a country:=CA b)'
        );
        expect(toggleTerm('is:qr || country:=CA', 'country:=CA')).toBe('is:qr || country:=CA');
        expect(hasTerm('is:qr || country:=CA', 'country:=CA')).toBe(false);
        expect(hasTerm('is:bot && country:=CA', 'country:=CA')).toBe(false);
        expect(hasTerm('os:"x country:=CA y"', 'country:=CA')).toBe(false);
        expect(toggleTerm('(a || b) country:=CA', 'country:=CA')).toBe('(a || b)');
        expect(hasTerm('-country:=CA', 'country:=CA')).toBe(false);
    });

    test('autocomplete splits only at && and ||', () => {
        const text = 'destination:https://x/?a=1&b';
        expect(termAt(text, text.length).term).toBe(text);
        expect(termAt('a&&os:i', 7).term).toBe('os:i');
        expect(termAt('(a||os:i)', 8)).toEqual({ start: 4, end: 8, term: 'os:i' });
    });
});
