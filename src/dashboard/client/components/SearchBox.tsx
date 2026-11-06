import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import {
    CLICK_DIALECT,
    describeSearch,
    parseSearch,
    quoteValue,
    type SearchDialect,
    tokenize
} from '../../../analytics/search.ts';
import { SEARCH_FIELDS, SEARCH_FLAGS, type SearchField } from '../../../shared/search.ts';
import { api } from '../api.ts';
import { formatCount } from '../format.ts';
import { useApi } from '../useApi.ts';

const SUGGEST_DELAY_MS = 150;
const MAX_SUGGESTIONS = 12;

/** What a search box searches: its fields, flags and where values come from. */
export interface SearchSyntax {
    /** The input's accessible name. */
    label: string;
    placeholder: string;
    /** Listed when nothing is typed, and as the term is typed. */
    fields: readonly SearchField[];
    /** The options after `is:`. */
    flags: readonly SearchField[];
    /** The options after `has:`. */
    has: readonly SearchField[];
    /** How its fields read, so the hover explains a search the way the server runs it. */
    dialect: SearchDialect;
    /** Whether `field:` has value suggestions. */
    hasValues: (field: string) => boolean;
    /** Suggested values for `field:`, most useful first. */
    loadValues: (field: string, text: string) => Promise<{ value: string; hint: string }[]>;
    /** Changes whenever the values would (e.g. the date range); part of the cache key. */
    key: string;
}

/** Fields without value suggestions: no single column, or not a column at all. */
const NO_VALUES = new Set(['utm', 'is', 'has']);

/** The click search: every recorded field, with values from the clicks in range. */
export function clickSyntax(params: URLSearchParams): SearchSyntax {
    return {
        label: 'Search clicks',
        placeholder: 'Search clicks: ip:, isp:, os:, ram:>=8, is:bot, …',
        fields: SEARCH_FIELDS,
        flags: SEARCH_FLAGS,
        has: SEARCH_FIELDS.filter(f => !NO_VALUES.has(f.name)),
        dialect: CLICK_DIALECT,
        // `query.<key>:` has no column to suggest from.
        hasValues: field => !NO_VALUES.has(field) && !field.includes('.'),
        loadValues: async (field, text) => {
            const query = new URLSearchParams(params);
            query.set('field', field);
            query.set('text', text);
            const res = await api.suggest(query);
            return res.values.map(v => ({
                value: v.value,
                hint: `${formatCount(v.clicks)} ${v.clicks === 1 ? 'click' : 'clicks'}`
            }));
        },
        key: params.toString()
    };
}

interface Suggestion {
    /** Replaces the term being typed. */
    insert: string;
    label: string;
    hint: string;
    /** A field name: keep the list open for its values instead of running the search. */
    partial?: boolean;
}

/** The term around the caret, between whitespace, brackets, `||` and `&&`: where it starts and ends in `text`. */
export function termAt(text: string, caret: number) {
    // A single `|` or `&` is part of a value (`?a=1&b=2`), as in the tokenizer.
    let start = 0;
    for (const m of text.slice(0, caret).matchAll(/[\s()]|\|\||&&/g)) start = m.index + m[0].length;
    const rest = text.slice(caret).search(/[\s()]|\|\||&&|$/);
    return { start, end: caret + rest, term: text.slice(start, caret) };
}

/**
 * `search` with `term` added (AND-ed), unless it already stands on its own at the top
 * level (see `hasTerm`). Anywhere else, such as inside brackets or beside a top-level
 * `||`, it's added again, which narrows the search when it was one side of an `||`.
 * A search with a top-level `||` or `&&` is bracketed first, so the term applies to
 * all of it and `hasTerm` finds it afterwards.
 */
export function withTerm(search: string, term: string): string {
    let current = search.trim();
    if (hasTerm(current, term)) return current;
    if (current === '') return term;
    // Close brackets still open while typing (`-(is:bot`), so the term isn't added inside them.
    let open = 0;
    for (const token of tokenize(current)) {
        if ('op' in token && token.op !== '||' && token.op !== '&&')
            open = Math.max(0, open + (token.op === ')' ? -1 : 1));
    }
    current += ')'.repeat(open);
    return `${topLevelTerms(current) === null ? `(${current})` : current} ${term}`;
}

/**
 * The terms AND-ed at the top level of `search`: split at whitespace outside quotes and
 * brackets. Null when `||` or `&&` joins them there, since taking one out would leave
 * the operator dangling.
 */
function topLevelTerms(search: string): string[] | null {
    const terms: string[] = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < search.length; i++) {
        const c = search.charAt(i);
        if (quoted) {
            if (c === '\\') i++;
            else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (depth > 0) continue;
        else if (search.startsWith('||', i) || search.startsWith('&&', i)) return null;
        else if (/\s/.test(c)) {
            if (i > start) terms.push(search.slice(start, i));
            start = i + 1;
        }
    }
    if (start < search.length) terms.push(search.slice(start));
    return terms;
}

/**
 * How the search reads a term, so `Country:=ca` and `os:="iOS"` match `country:=CA` and
 * `os:=iOS`. Values ignore case like the server's NOCASE and LIKE, which fold only A–Z;
 * query parameter keys keep theirs (they're in `field`).
 */
function parsedTerm(text: string): string {
    return JSON.stringify(
        tokenize(text).map(token =>
            'value' in token
                ? { ...token, value: token.value.replaceAll(/[A-Z]/g, c => c.toLowerCase()) }
                : token
        )
    );
}

/** Whether `term` stands on its own at the top level of `search`, so `toggleTerm` would remove it. */
export function hasTerm(search: string, term: string): boolean {
    const parsed = parsedTerm(term);
    return topLevelTerms(search.trim())?.some(t => parsedTerm(t) === parsed) ?? false;
}

/** `search` without `term` where it stands on its own at the top level, or with it added (as `withTerm`). */
export function toggleTerm(search: string, term: string): string {
    const parsed = parsedTerm(term);
    const terms = topLevelTerms(search.trim());
    return terms?.some(t => parsedTerm(t) === parsed)
        ? terms.filter(t => parsedTerm(t) !== parsed).join(' ')
        : withTerm(search, term);
}

/**
 * A chip's key: its term and which occurrence of that term it is. Encoded as JSON so no
 * term can spell another's key (with a suffix like `#2`, a literal `a#2` would clash
 * with the second `a`).
 */
export const chipKey = (term: string, occurrence = 1) => JSON.stringify([term, occurrence]);

/** One filter in a search, shown as a chip that takes it back off. */
export interface SearchChip {
    /** Stable while the chip stays: the term and which occurrence of it this is (`chipKey`). */
    key: string;
    /** What the chip shows. */
    label: string;
    /** The search without this filter. */
    rest: string;
}

/**
 * The filters in `search`, one chip each: the terms AND-ed at its top level, as
 * `hasTerm` and `toggleTerm` see them, with a bracketed group as one chip. A search
 * joined by `||` or `&&` at the top level can't lose one side without changing what the
 * other means, so it's a single chip that clears it.
 */
export function searchChips(search: string): SearchChip[] {
    const whole = search.trim();
    if (whole === '') return [];
    const terms = topLevelTerms(whole);
    if (!terms) return [{ key: chipKey(whole), label: whole, rest: '' }];
    const seen = new Map<string, number>();
    return terms.map((term, i) => {
        const n = (seen.get(term) ?? 0) + 1;
        seen.set(term, n);
        return {
            key: chipKey(term, n),
            label: term,
            rest: terms.filter((_, j) => j !== i).join(' ')
        };
    });
}

/** `field:=value`, quoted (and escaped) when a bare value couldn't hold it. */
export function exactTerm(field: string, value: string): string {
    return `${field}:=${quoteValue(value)}`;
}

/** What the term being typed is: a field name, or `field:` and the start of its value. */
function parseTerm(term: string) {
    const negate = term.startsWith('-') ? '-' : '';
    const body = term.slice(negate.length);
    const colon = body.indexOf(':');
    if (colon === -1) return { negate, field: null, text: body };
    return {
        negate,
        field: body.slice(0, colon).toLowerCase(),
        text: body.slice(colon + 1).replace(/^=?"?/, '')
    };
}

/** How the server will read `search`, or why it can't; null when there's nothing to explain. */
function interpretation(search: string, dialect: SearchDialect): string | null {
    try {
        const tree = parseSearch(search, dialect);
        return tree && describeSearch(tree);
    } catch (error) {
        return error instanceof Error ? error.message : null;
    }
}

interface SearchBoxProps {
    value: string;
    onChange: (value: string) => void;
    /** Run the search now (Enter, or a completed suggestion). */
    onCommit: (value: string) => void;
    syntax: SearchSyntax;
    /** What the applied search found, shown at the end of the input; omitted until known. */
    count?: { label: string; stale: boolean };
}

/** A search input with suggestions for field names, flags and common values. */
export function SearchBox({ value, onChange, onCommit, syntax, count }: SearchBoxProps) {
    const listId = useId();
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLUListElement>(null);
    const [caret, setCaret] = useState(0);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const nextCaret = useRef<number | null>(null);

    const { start, end, term } = termAt(value, caret);
    const { negate, field, text } = parseTerm(term);

    // Values come from the API, a moment after typing stops.
    const valueField =
        field !== null && field !== 'is' && field !== 'has' && syntax.hasValues(field)
            ? field
            : null;
    const wanted = valueField === null ? null : `${valueField}|${text}`;
    const [asked, setAsked] = useState<string | null>(null);
    useEffect(() => {
        const timer = setTimeout(() => setAsked(wanted), SUGGEST_DELAY_MS);
        return () => clearTimeout(timer);
    }, [wanted]);
    const bar = asked?.indexOf('|') ?? -1;
    const askedField = asked?.slice(0, bar) ?? '';
    const values = useApi(open && asked !== null ? `suggest|${syntax.key}|${asked}` : null, () =>
        syntax
            .loadValues(askedField, asked?.slice(bar + 1) ?? '')
            .then(list => ({ field: askedField, values: list }))
    );

    let suggestions: Suggestion[] = [];
    if (field === null) {
        // Nothing typed yet lists every field, so they can be browsed.
        const typed = text.toLowerCase();
        suggestions = syntax.fields
            .filter(f => f.name.startsWith(typed))
            .map(f => ({
                insert: `${negate}${f.name}:`,
                label: `${f.name}:`,
                hint: f.hint,
                partial: true
            }));
    } else if (field === 'is' || field === 'has') {
        const options = field === 'is' ? syntax.flags : syntax.has;
        suggestions = options
            .filter(f => f.name.startsWith(text.toLowerCase()) && f.name !== text.toLowerCase())
            .map(f => ({ insert: `${negate}${field}:${f.name} `, label: f.name, hint: f.hint }));
    } else if (values.data?.field === field && asked === wanted) {
        suggestions = values.data.values
            .filter(v => v.value !== text)
            .slice(0, MAX_SUGGESTIONS)
            .map(v => ({
                insert: `${negate}${exactTerm(field, v.value)} `,
                label: v.value,
                hint: v.hint
            }));
    }
    const shown = open && suggestions.length > 0;
    const explained = interpretation(value, syntax.dialect);
    const highlighted = shown && active < suggestions.length ? active : -1;

    // Put the caret after an accepted suggestion once the new value has rendered.
    useLayoutEffect(() => {
        if (nextCaret.current === null || !input.current) return;
        input.current.setSelectionRange(nextCaret.current, nextCaret.current);
        nextCaret.current = null;
    }, [value]);

    // Keep the highlighted suggestion in view as the arrow keys move through a long list.
    useEffect(() => {
        if (highlighted >= 0)
            list.current?.children[highlighted]?.scrollIntoView({ block: 'nearest' });
    }, [highlighted]);

    const update = (next: string, at: number) => {
        onChange(next);
        setCaret(at);
        setActive(-1);
    };

    const accept = (s: Suggestion) => {
        const after = value.slice(end);
        const next = value.slice(0, start) + s.insert + (s.partial ? after : after.trimStart());
        const at = start + s.insert.length;
        nextCaret.current = at;
        update(next, at);
        if (!s.partial) onCommit(next);
    };

    return (
        <div
            className="search-box"
            style={count ? ({ '--count-ch': count.label.length } as CSSProperties) : undefined}
        >
            <input
                ref={input}
                type="search"
                role="combobox"
                aria-label={syntax.label}
                aria-expanded={shown}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-describedby={explained ? `${listId}-explain` : undefined}
                aria-activedescendant={highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
                value={value}
                placeholder={syntax.placeholder}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                onChange={e => {
                    update(e.target.value, e.target.selectionStart ?? e.target.value.length);
                    setOpen(true);
                }}
                onSelect={e => setCaret(e.currentTarget.selectionStart ?? 0)}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={e => {
                    if (e.key === 'Escape' && shown) {
                        e.preventDefault();
                        setOpen(false);
                    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        if (!shown) {
                            setOpen(true);
                            return;
                        }
                        e.preventDefault();
                        const step = e.key === 'ArrowDown' ? 1 : -1;
                        setActive((highlighted + step + suggestions.length) % suggestions.length);
                    } else if (
                        shown &&
                        ((e.key === 'Enter' && highlighted >= 0) || e.key === 'Tab')
                    ) {
                        const pick = suggestions[Math.max(highlighted, 0)];
                        if (!pick) return;
                        e.preventDefault();
                        accept(pick);
                    }
                }}
            />
            {count && (
                <span className="search-count" role="status" data-stale={count.stale}>
                    {count.label}
                </span>
            )}
            {explained && !shown && (
                <div className="search-explain" id={`${listId}-explain`}>
                    {explained}
                </div>
            )}
            {shown && (
                <ul
                    ref={list}
                    className="suggestions"
                    id={listId}
                    role="listbox"
                    aria-label="Suggestions"
                >
                    {suggestions.map((s, i) => (
                        <li
                            key={s.insert}
                            id={`${listId}-${i}`}
                            role="option"
                            aria-selected={i === highlighted}
                            // Keep focus in the input.
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => accept(s)}
                            onMouseEnter={() => setActive(i)}
                        >
                            <span className="suggestion-label">{s.label}</span>
                            <span className="suggestion-hint">{s.hint}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
