import { useState } from 'react';

import { api } from '../api.ts';
import { useApi } from '../useApi.ts';

export interface PickedLink {
    id: number;
    slug: string;
}

interface LinkPickerProps {
    value: PickedLink[];
    onChange: (links: PickedLink[]) => void;
}

/** Chosen links as removable chips, plus a search to add more. */
export function LinkPicker({ value, onChange }: LinkPickerProps) {
    const [query, setQuery] = useState('');
    const q = query.trim();
    const results = useApi(q ? `link-picker:${q}` : null, () =>
        api.links(new URLSearchParams({ q, limit: '8' }))
    );
    const chosen = new Set(value.map(l => l.id));
    const matches = (results.data?.links ?? []).filter(l => !chosen.has(l.id));

    return (
        <div className="link-picker">
            {value.length > 0 && (
                <ul className="link-picker-chosen">
                    {value.map(link => (
                        <li key={link.id} className="chip">
                            /{link.slug}
                            <button
                                type="button"
                                className="icon-button"
                                aria-label={`Remove /${link.slug}`}
                                onClick={() => onChange(value.filter(l => l.id !== link.id))}
                            >
                                ×
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <input
                type="search"
                value={query}
                placeholder="Search links to add"
                aria-label="Search links to add"
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                    // Enter picks the first match instead of submitting the whole form.
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const first = matches[0];
                    if (first) {
                        onChange([...value, { id: first.id, slug: first.slug }]);
                        setQuery('');
                    }
                }}
            />
            {q && (
                <ul className="link-picker-results">
                    {matches.map(link => (
                        <li key={link.id}>
                            <button
                                type="button"
                                onClick={() => {
                                    onChange([...value, { id: link.id, slug: link.slug }]);
                                    setQuery('');
                                }}
                            >
                                <span className="slug">/{link.slug}</span>
                                <span className="muted">{link.title ?? link.url}</span>
                            </button>
                        </li>
                    ))}
                    {results.data && matches.length === 0 && (
                        <li className="muted">No other links match.</li>
                    )}
                </ul>
            )}
        </div>
    );
}
