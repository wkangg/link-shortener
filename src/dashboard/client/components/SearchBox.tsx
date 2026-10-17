import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

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
        hasValues: field => !NO_VALUES.has(field),
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

/** The whitespace-separated term around the caret: where it starts and ends in `text`. */
function termAt(text: string, caret: number) {
    const start = text.slice(0, caret).search(/\S*$/);
    const rest = text.slice(caret).search(/\s|$/);
    return { start, end: caret + rest, term: text.slice(start, caret) };
}

function quoted(value: string): string {
    return /[\s"]/.test(value) ? `"${value.replaceAll('"', '')}"` : value;
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
                insert: `${negate}${field}:=${quoted(v.value)} `,
                label: v.value,
                hint: v.hint
            }));
    }
    const shown = open && suggestions.length > 0;
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
