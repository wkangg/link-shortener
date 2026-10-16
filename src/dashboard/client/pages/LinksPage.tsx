import { useState } from 'react';

import type { LinkWithStats } from '../../../shared/types.ts';
import { api, localTz } from '../api.ts';
import { CreateBar } from '../components/CreateBar.tsx';
import { LinkActions } from '../components/LinkActions.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { useConfig } from '../config.tsx';
import { formatCount, formatDate, hostOf } from '../format.ts';
import { linkClick, navigate, useLocation } from '../router.ts';
import { useApi } from '../useApi.ts';

const PAGE = 50;

export function LinksPage() {
    const { shortOrigin } = useConfig();
    const { search } = useLocation();
    const [q, setQ] = useState('');
    const [tag, setTag] = useState<string | null>(null);
    const [sort, setSort] = useState<'created' | 'clicks'>('created');
    const [archived, setArchived] = useState(false);
    const [limit, setLimit] = useState(PAGE);
    const [version, setVersion] = useState(0);
    const refresh = () => setVersion(v => v + 1);

    // The bookmarklet opens /links?new=<url>.
    const initialUrl = search.get('new') ?? '';

    const params = new URLSearchParams({ sort, limit: String(limit), tz: String(localTz()) });
    if (q.trim()) params.set('q', q.trim());
    if (tag) params.set('tag', tag);
    if (archived) params.set('archived', '1');
    const { data, error, loading } = useApi(`${version}|${params}`, () => api.links(params));
    const tags = useApi(`tags|${version}`, () => api.tags());

    return (
        <main className="page">
            <CreateBar
                shortOrigin={shortOrigin}
                initialUrl={initialUrl}
                onCreated={() => {
                    if (initialUrl) navigate('/links', true);
                    refresh();
                }}
            />

            <div className="list-controls">
                <label className="field-inline grow">
                    <span className="visually-hidden">Search links</span>
                    <input
                        type="search"
                        placeholder="Search by slug, destination or title"
                        value={q}
                        onChange={e => setQ(e.target.value)}
                    />
                </label>
                <label className="field-inline">
                    <span className="visually-hidden">Sort</span>
                    <select
                        value={sort}
                        onChange={e => setSort(e.target.value as 'created' | 'clicks')}
                    >
                        <option value="created">Newest first</option>
                        <option value="clicks">Most clicked</option>
                    </select>
                </label>
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={archived}
                        onChange={e => setArchived(e.target.checked)}
                    />
                    Archived
                </label>
            </div>

            {(tags.data?.length ?? 0) > 0 && (
                <ul className="chips tag-filter" aria-label="Filter by tag">
                    {tags.data?.map(t => (
                        <li key={t.tag}>
                            <button
                                type="button"
                                className="chip"
                                aria-pressed={tag === t.tag}
                                onClick={() =>
                                    setTag(current => (current === t.tag ? null : t.tag))
                                }
                            >
                                {t.tag} <span className="muted">{t.count}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {error && <p className="error">Couldn’t load links: {error.message}</p>}
            {data?.links.length === 0 && !loading && (
                <p className="empty">
                    {q || tag || archived
                        ? 'No links match.'
                        : 'No links yet. Paste one above to make your first.'}
                </p>
            )}

            <ul className="link-list">
                {data?.links.map(link => (
                    <LinkRow
                        key={link.id}
                        link={link}
                        host={hostOf(shortOrigin)}
                        onTag={setTag}
                        onChanged={refresh}
                    />
                ))}
            </ul>

            {data && data.total > data.links.length && (
                <button
                    type="button"
                    className="button load-more"
                    onClick={() => setLimit(l => l + PAGE)}
                >
                    Show more ({data.total - data.links.length} left)
                </button>
            )}
        </main>
    );
}

function LinkRow({
    link,
    host,
    onTag,
    onChanged
}: {
    link: LinkWithStats;
    host: string;
    onTag: (tag: string) => void;
    onChanged: () => void;
}) {
    const expired = link.expiresAt !== null && link.expiresAt < link.updatedAt;
    return (
        <li className="link-row">
            <div className="link-main">
                <a className="slug" href={`/links/${link.id}`} onClick={linkClick}>
                    <span className="slug-host">{host}/</span>
                    {link.slug}
                </a>
                <p className="destination" title={link.url}>
                    {link.title && <strong>{link.title} </strong>}
                    {link.url}
                </p>
                <p className="link-meta">
                    <span>{formatDate(link.createdAt)}</span>
                    {link.expiresAt !== null && (
                        <span className={expired ? 'warn' : undefined}>
                            Expires {formatDate(link.expiresAt)}
                        </span>
                    )}
                    {link.redirectType !== 302 && <span>{link.redirectType}</span>}
                    {link.trackDevice && <span title="Detailed device tracking">tracked</span>}
                    {link.tags.map(t => (
                        <button key={t} type="button" className="tag" onClick={() => onTag(t)}>
                            {t}
                        </button>
                    ))}
                </p>
            </div>
            <div className="link-stats" title="Clicks in the last 7 days">
                <Sparkline values={link.spark} />
                <span className="link-clicks">
                    {formatCount(link.clicks)}
                    <span className="visually-hidden"> clicks</span>
                </span>
            </div>
            <LinkActions link={link} onChanged={onChanged} onDeleted={onChanged} />
        </li>
    );
}
