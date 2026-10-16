import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { SEARCH_FIELDS, SEARCH_FLAGS } from '../../../shared/search.ts';
import { api } from '../api.ts';
import { formatCount } from '../format.ts';
import { useApi } from '../useApi.ts';

const SUGGEST_DELAY_MS = 150;
const MAX_SUGGESTIONS = 12;
/** Fields without value suggestions: no single column, or not a column at all. */
const NO_VALUES = new Set(['utm', 'is', 'has']);

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
    /** Stats query params, so value suggestions match the range and filters. */
    params: URLSearchParams;
}

/** The click search input, with suggestions for field names, flags and common values. */
export function SearchBox({ value, onChange, onCommit, params }: SearchBoxProps) {
    const listId = useId();
    const input = useRef<HTMLInputElement>(null);
    const [caret, setCaret] = useState(0);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const nextCaret = useRef<number | null>(null);

    const { start, end, term } = termAt(value, caret);
    const { negate, field, text } = parseTerm(term);

    // Values come from the API, a moment after typing stops.
    const valueField = field !== null && !NO_VALUES.has(field) ? field : null;
    const wanted = valueField === null ? null : `${valueField}|${text}`;
    const [asked, setAsked] = useState<string | null>(null);
    useEffect(() => {
        const timer = setTimeout(() => setAsked(wanted), SUGGEST_DELAY_MS);
        return () => clearTimeout(timer);
    }, [wanted]);
    const query = new URLSearchParams(params);
    if (asked !== null) {
        const bar = asked.indexOf('|');
        query.set('field', asked.slice(0, bar));
        query.set('text', asked.slice(bar + 1));
    }
    const values = useApi(open && asked !== null ? `suggest|${query}` : null, () =>
        api.suggest(query)
    );

    let suggestions: Suggestion[] = [];
    if (field === null) {
        const typed = text.toLowerCase();
        if (typed) {
            suggestions = SEARCH_FIELDS.filter(f => f.name.startsWith(typed)).map(f => ({
                insert: `${negate}${f.name}:`,
                label: `${f.name}:`,
                hint: f.hint,
                partial: true
            }));
        }
    } else if (field === 'is' || field === 'has') {
        const options =
            field === 'is' ? SEARCH_FLAGS : SEARCH_FIELDS.filter(f => !NO_VALUES.has(f.name));
        suggestions = options
            .filter(f => f.name.startsWith(text.toLowerCase()) && f.name !== text.toLowerCase())
            .map(f => ({ insert: `${negate}${field}:${f.name} `, label: f.name, hint: f.hint }));
    } else if (values.data?.field === field && asked === wanted) {
        suggestions = values.data.values
            .filter(v => v.value !== text)
            .map(v => ({
                insert: `${negate}${field}:=${quoted(v.value)} `,
                label: v.value,
                hint: `${formatCount(v.clicks)} ${v.clicks === 1 ? 'click' : 'clicks'}`
            }));
    }
    suggestions = suggestions.slice(0, MAX_SUGGESTIONS);
    const shown = open && suggestions.length > 0;
    const highlighted = shown && active < suggestions.length ? active : -1;

    // Put the caret after an accepted suggestion once the new value has rendered.
    useLayoutEffect(() => {
        if (nextCaret.current === null || !input.current) return;
        input.current.setSelectionRange(nextCaret.current, nextCaret.current);
        nextCaret.current = null;
    }, [value]);

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
        <div className="search-box">
            <input
                ref={input}
                type="search"
                role="combobox"
                aria-label="Search clicks"
                aria-expanded={shown}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
                value={value}
                placeholder="Search clicks: ip:, isp:, os:, ram:>=8, is:bot, …"
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
            {shown && (
                <ul className="suggestions" id={listId} role="listbox" aria-label="Suggestions">
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
