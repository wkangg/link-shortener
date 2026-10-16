import { useState } from 'react';

import type { ClickHistoryRow, TopRow } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { countryLabel, formatCount, formatDateTime } from '../format.ts';
import { useApi } from '../useApi.ts';

/** "All" still pages, just in very large pages, so a huge history can't freeze the tab. */
const ALL = 10_000;
const PAGE_SIZES = [
    { value: 25, label: '25' },
    { value: 50, label: '50' },
    { value: 100, label: '100' },
    { value: 250, label: '250' },
    { value: ALL, label: 'All' }
] as const;
const DEFAULT_SIZE = 50;
const SIZE_KEY = 'clickHistory.pageSize';

/** Remembered per browser; storage can be unavailable (private windows, blocked storage). */
function savedSize(): number {
    try {
        const saved = Number(localStorage.getItem(SIZE_KEY));
        return PAGE_SIZES.some(s => s.value === saved) ? saved : DEFAULT_SIZE;
    } catch {
        return DEFAULT_SIZE;
    }
}

function saveSize(size: number): void {
    try {
        localStorage.setItem(SIZE_KEY, String(size));
    } catch {
        // Not remembered; still applies for this session.
    }
}

interface ClickHistoryProps {
    /** Stats query params (range, link, filters, bots). */
    params: URLSearchParams;
    refreshKey: string;
    /** Hide the link column on a single link's page. */
    showLink: boolean;
    onSelect: (dim: string, row: TopRow) => void;
}

function location(c: ClickHistoryRow): string {
    const place = [c.city, c.region].filter(Boolean).join(', ');
    const country = c.country ? countryLabel(c.country) : '';
    return [place, country].filter(Boolean).join(' · ') || '–';
}

function technology(c: ClickHistoryRow): string {
    return [c.browser, c.os, c.device].filter(Boolean).join(' · ') || 'Unknown';
}

const asRow = (value: string, label: string): TopRow => ({ value, label, clicks: 0, visitors: 0 });

export function ClickHistory({ params, refreshKey, showLink, onSelect }: ClickHistoryProps) {
    // Back to the first page whenever the range, filters or bots toggle change.
    const base = String(params);
    const [paging, setPaging] = useState({ base, page: 0 });
    const [size, setSize] = useState(savedSize);
    const requested = paging.base === base ? paging.page : 0;

    const query = new URLSearchParams(params);
    query.set('limit', String(size));
    query.set('offset', String(requested * size));
    const { data, error, loading } = useApi(`clicks|${refreshKey}|${query}`, () =>
        api.clicks(query)
    );
    const clicks = data?.clicks ?? [];
    const total = data?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(requested, pages - 1);
    // Asked for a page past the end (clicks aged out of the range): fetch the last real one.
    // Adjusting state while rendering is React's recommended alternative to an effect here.
    if (data && requested > pages - 1) setPaging({ base, page: pages - 1 });
    const goTo = (next: number) =>
        setPaging({ base, page: Math.min(Math.max(next, 0), pages - 1) });
    const first = page * size + 1;
    const last = page * size + clicks.length;
    const changeSize = (next: number) => {
        // Stay on the page that contains the first row currently shown.
        setPaging({ base, page: Math.floor((page * size) / next) });
        setSize(next);
        saveSize(next);
    };

    return (
        <section className="panel history" aria-label="Click history">
            <header className="panel-header">
                <h3>Click history</h3>
                <span className="history-hint">Every request, newest first</span>
            </header>
            {error && <p className="panel-empty">Couldn’t load: {error.message}</p>}
            {!error && data && total === 0 && <p className="panel-empty">Nothing yet</p>}
            {clicks.length > 0 && (
                <div className="history-scroll">
                    <table className="history-table">
                        <thead>
                            <tr>
                                <th scope="col">Time</th>
                                {showLink && <th scope="col">Link</th>}
                                <th scope="col">IP address</th>
                                <th scope="col">Location</th>
                                <th scope="col">Source</th>
                                <th scope="col">User agent</th>
                            </tr>
                        </thead>
                        <tbody>
                            {clicks.map(c => (
                                <tr key={c.id}>
                                    <td className="nowrap" title={new Date(c.ts).toISOString()}>
                                        {formatDateTime(c.ts)}
                                    </td>
                                    {showLink && (
                                        <td className="mono">
                                            {c.slug === null ? (
                                                <span className="muted">deleted</span>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="cell-filter"
                                                    title="Filter to this link"
                                                    onClick={() =>
                                                        onSelect(
                                                            'link',
                                                            asRow(
                                                                String(c.linkId),
                                                                c.slug === '' ? '/' : (c.slug ?? '')
                                                            )
                                                        )
                                                    }
                                                >
                                                    {c.slug === '' ? '/' : c.slug}
                                                </button>
                                            )}
                                        </td>
                                    )}
                                    <td className="mono nowrap">
                                        {c.ip === null ? (
                                            <span className="muted">–</span>
                                        ) : (
                                            <button
                                                type="button"
                                                className="cell-filter"
                                                title="Filter to this IP address"
                                                onClick={() =>
                                                    onSelect('ip', asRow(c.ip ?? '', c.ip ?? ''))
                                                }
                                            >
                                                {c.ip}
                                            </button>
                                        )}
                                    </td>
                                    <td>{location(c)}</td>
                                    <td>
                                        {c.source}
                                        {c.referrer && (
                                            <span className="history-sub" title={c.referrer}>
                                                {c.referrer}
                                            </span>
                                        )}
                                    </td>
                                    <td className="history-ua">
                                        {technology(c)}
                                        {c.bot && <span className="badge">bot</span>}
                                        {c.userAgent && (
                                            <span className="history-sub mono">{c.userAgent}</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {total > 0 && clicks.length > 0 && (
                <nav className="pager" aria-label="Click history pages">
                    <div className="pager-info">
                        <span className="pager-range">
                            {formatCount(first)}–{formatCount(last)} of {formatCount(total)}
                        </span>
                        <label className="pager-size">
                            Per page
                            <select value={size} onChange={e => changeSize(Number(e.target.value))}>
                                {PAGE_SIZES.map(s => (
                                    <option key={s.value} value={s.value}>
                                        {s.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    {pages > 1 && (
                        <div className="pager-buttons">
                            <button
                                type="button"
                                className="button small"
                                disabled={page === 0 || loading}
                                onClick={() => goTo(0)}
                                aria-label="Newest page"
                            >
                                «
                            </button>
                            <button
                                type="button"
                                className="button small"
                                disabled={page === 0 || loading}
                                onClick={() => goTo(page - 1)}
                            >
                                Newer
                            </button>
                            <span className="pager-page">
                                Page {formatCount(page + 1)} of {formatCount(pages)}
                            </span>
                            <button
                                type="button"
                                className="button small"
                                disabled={page >= pages - 1 || loading}
                                onClick={() => goTo(page + 1)}
                            >
                                Older
                            </button>
                            <button
                                type="button"
                                className="button small"
                                disabled={page >= pages - 1 || loading}
                                onClick={() => goTo(pages - 1)}
                                aria-label="Oldest page"
                            >
                                »
                            </button>
                        </div>
                    )}
                </nav>
            )}
        </section>
    );
}
