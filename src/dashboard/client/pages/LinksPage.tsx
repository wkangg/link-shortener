import { useState } from 'react';

import {
    LINK_SEARCH_DIALECT,
    LINK_SEARCH_FIELDS,
    LINK_SEARCH_HAS
} from '../../../shared/search.ts';
import type { LinkWithStats } from '../../../shared/types.ts';
import { api, localTz } from '../api.ts';
import { CreateBar } from '../components/CreateBar.tsx';
import { LinkActions, useCopy } from '../components/LinkActions.tsx';
import { SearchBox, type SearchSyntax } from '../components/SearchBox.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { KIND_LABELS } from '../components/WebhookEditor.tsx';
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
    const { data, error, loading } = useApi(
        `${version}|${params}`,
        () => api.links(params),
        'links'
    );
    const tags = useApi(`tags|${version}`, () => api.tags(), 'tags');

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
                <div className="field-inline grow">
                    <SearchBox value={q} onChange={setQ} onCommit={setQ} syntax={LINK_SYNTAX} />
                </div>
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

const LINK_VALUE_FIELDS = new Set(['slug', 'destination', 'url', 'title', 'tag', 'webhook']);

/** Slugs, destinations or titles of links matching what's typed, each with a reminder of the link. */
async function linkValues(field: string, text: string) {
    const params = new URLSearchParams({ limit: '20' });
    // Search that field only, so the suggestions contain what's typed.
    if (text) params.set('q', `${field}:${text.includes(' ') ? `"${text}"` : text}`);
    const { links } = await api.links(params);
    const values = new Map<string, string>();
    for (const link of links) {
        const value = field === 'slug' ? link.slug : field === 'title' ? link.title : link.url;
        if (!value || values.has(value)) continue;
        values.set(value, field === 'slug' ? (link.title ?? link.url) : `/${link.slug}`);
    }
    return [...values].map(([value, hint]) => ({ value, hint }));
}

/** The links search: slug, destination and title, plus webhook and tracking filters. */
const LINK_SYNTAX: SearchSyntax = {
    label: 'Search links',
    placeholder: 'Search links: slug, destination, title, tag:, webhook:, has:tracking, …',
    fields: LINK_SEARCH_FIELDS,
    flags: [],
    has: LINK_SEARCH_HAS,
    dialect: LINK_SEARCH_DIALECT,
    hasValues: field => LINK_VALUE_FIELDS.has(field),
    loadValues: async (field, text) => {
        const typed = text.toLowerCase();
        if (field === 'tag') {
            const tags = await api.tags();
            return tags
                .filter(t => t.tag.includes(typed.replace(/^#/, '')))
                .map(t => ({
                    value: t.tag,
                    hint: `${t.count} ${t.count === 1 ? 'link' : 'links'}`
                }));
        }
        if (field !== 'webhook') return linkValues(field, text);
        // Webhook names, as the rows and the search know them.
        const endpoints = await api.webhooks();
        return endpoints
            .map(e => ({
                value: e.description ?? (e.kind === 'discord' ? 'Discord' : hostOf(e.url)),
                hint: [
                    KIND_LABELS[e.kind],
                    e.allLinks ? 'every link' : null,
                    e.enabled ? null : 'off'
                ]
                    .filter(Boolean)
                    .join(', ')
            }))
            .filter(v => v.value.toLowerCase().includes(typed));
    },
    key: 'links'
};

/** "→ #clicks", "→ 2 webhooks" or "→ webhook off", naming them all on hover. */
function WebhookMarker({ webhooks }: { webhooks: LinkWithStats['webhooks'] }) {
    if (webhooks.length === 0) return null;
    const on = webhooks.filter(w => w.enabled);
    const title = `Sends clicks to: ${webhooks
        .map(w => {
            const notes = [w.allLinks ? 'every link' : null, w.enabled ? null : 'off'].filter(
                Boolean
            );
            return notes.length > 0 ? `${w.name} (${notes.join(', ')})` : w.name;
        })
        .join(', ')}`;
    const text =
        on.length === 0
            ? webhooks.length === 1
                ? 'webhook off'
                : 'webhooks off'
            : on.length === 1
              ? (on[0]?.name ?? 'webhook')
              : `${on.length} webhooks`;
    return (
        <span className={on.length > 0 ? 'webhook-marker' : 'webhook-marker off'} title={title}>
            → {text}
        </span>
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
    const { shortOrigin } = useConfig();
    const copy = useCopy();
    const expired = link.expiresAt !== null && link.expiresAt < link.updatedAt;
    return (
        <li className="link-row">
            {/* Covers the whole row; the buttons inside sit above it. */}
            <a
                className="row-link"
                href={`/links/${link.id}`}
                onClick={linkClick}
                aria-label={`${host}/${link.slug} details`}
            />
            <div className="link-main">
                <button
                    type="button"
                    className="slug"
                    title="Copy short link"
                    onClick={() =>
                        void copy(`${shortOrigin}/${link.slug}`, `Copied ${host}/${link.slug}`)
                    }
                >
                    <span className="slug-host">{host}/</span>
                    {link.slug}
                </button>
                <button
                    type="button"
                    className="destination"
                    title={`Copy ${link.url}`}
                    onClick={() => void copy(link.url, 'Copied destination')}
                >
                    {link.title && <strong>{link.title} </strong>}
                    {link.url}
                </button>
                <p className="link-meta">
                    <span>{formatDate(link.createdAt)}</span>
                    {link.expiresAt !== null && (
                        <span className={expired ? 'warn' : undefined}>
                            Expires {formatDate(link.expiresAt)}
                        </span>
                    )}
                    {link.redirectType !== 302 && <span>{link.redirectType}</span>}
                    {link.trackDevice && <span title="Detailed device tracking">tracked</span>}
                    <WebhookMarker webhooks={link.webhooks} />
                    {link.tags.map(t => (
                        <button key={t} type="button" className="tag" onClick={() => onTag(t)}>
                            {t}
                        </button>
                    ))}
                </p>
            </div>
            <div className="link-stats">
                <span title="Clicks in the last 7 days">
                    <Sparkline values={link.spark} />
                </span>
                <Stat value={link.clicks} one="click" many="clicks" />
                <Stat value={link.visitors} one="visitor" many="visitors" />
            </div>
            <LinkActions link={link} onChanged={onChanged} onDeleted={onChanged} />
        </li>
    );
}

function Stat({ value, one, many }: { value: number; one: string; many: string }) {
    return (
        <span className="link-stat">
            {formatCount(value)}
            <span className="link-stat-label"> {value === 1 ? one : many}</span>
        </span>
    );
}
