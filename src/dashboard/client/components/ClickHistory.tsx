import { useState } from 'react';

import type { ClickHistoryRow, TopRow } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { countryLabel, formatDateTime } from '../format.ts';
import { useApi } from '../useApi.ts';

const PAGE = 50;
const MAX = 1000;

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
    // "Load more" grows the page size; it resets whenever the query changes.
    const base = String(params);
    const [paging, setPaging] = useState({ base, limit: PAGE });
    const limit = paging.base === base ? paging.limit : PAGE;

    const query = new URLSearchParams(params);
    query.set('limit', String(limit));
    const { data, error, loading } = useApi(`clicks|${refreshKey}|${query}`, () =>
        api.clicks(query)
    );
    const clicks = data?.clicks ?? [];

    return (
        <section className="panel history" aria-label="Click history">
            <header className="panel-header">
                <h3>Click history</h3>
                <span className="history-hint">Every request, newest first</span>
            </header>
            {error && <p className="panel-empty">Couldn’t load: {error.message}</p>}
            {!error && data && clicks.length === 0 && <p className="panel-empty">Nothing yet</p>}
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
                                            <span className="history-sub mono" title={c.userAgent}>
                                                {c.userAgent}
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {data?.next !== null && data !== undefined && limit < MAX && (
                <button
                    type="button"
                    className="button load-more"
                    disabled={loading}
                    onClick={() => setPaging({ base, limit: Math.min(limit + PAGE, MAX) })}
                >
                    {loading ? 'Loading…' : 'Load more'}
                </button>
            )}
            {data?.next !== null && limit >= MAX && (
                <p className="panel-empty">Showing the latest {MAX}. Export CSV for the rest.</p>
            )}
        </section>
    );
}
