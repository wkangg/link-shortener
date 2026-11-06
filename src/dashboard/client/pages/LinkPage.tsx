import { useEffect, useState } from 'react';

import { api, ApiRequestError } from '../api.ts';
import { Analytics } from '../components/Analytics.tsx';
import { LinkActions } from '../components/LinkActions.tsx';
import { LinkWebhooks } from '../components/LinkWebhooks.tsx';
import { useToast } from '../components/Toast.tsx';
import { useConfig } from '../config.tsx';
import { formatDateTime, hostOf, pageTitle } from '../format.ts';
import { linkClick, navigate } from '../router.ts';
import { useApi } from '../useApi.ts';

export function LinkPage({ id }: { id: number }) {
    const { shortOrigin } = useConfig();
    const toast = useToast();
    const [version, setVersion] = useState(0);
    const [webhooksOpen, setWebhooksOpen] = useState(false);
    // The archived state the last toggle started from, so only the label that replaces it
    // animates in: not the old one while the refresh is in flight, and not on load.
    const [toggledFrom, setToggledFrom] = useState<boolean | null>(null);
    const { data: link, error } = useApi(`${id}|${version}`, () => api.link(id), `link|${id}`);
    const slug = link?.slug;
    // Only a 404 means the link is gone; a network or server error says nothing about it.
    const missing = error instanceof ApiRequestError && error.status === 404;

    // Replaces App's "Link · …" placeholder once the slug is known ("nl-oct · s.example"),
    // or says why there's no link, like unknown paths do.
    useEffect(() => {
        if (slug !== undefined) document.title = pageTitle(slug, shortOrigin);
        else if (error) document.title = pageTitle(missing ? 'Not found' : 'Error', shortOrigin);
    }, [slug, error, missing, shortOrigin]);

    if (error) {
        return (
            <main className="page">
                <p className="error">
                    {missing
                        ? 'This link doesn’t exist any more.'
                        : `Couldn’t load this link: ${error.message}`}
                </p>
                <a href="/links" onClick={linkClick}>
                    Back to links
                </a>
            </main>
        );
    }
    if (!link) return <main className="page" aria-busy="true" />;

    const toggleArchived = async () => {
        await api.updateLink(link.id, { archived: !link.archived });
        toast.show(link.archived ? 'Restored' : 'Archived: the short link now returns 404');
        setToggledFrom(link.archived);
        setVersion(v => v + 1);
    };

    return (
        <main className="page">
            <header className="link-header">
                <div>
                    <h1 className="slug slug-large">
                        <span className="slug-host">{hostOf(shortOrigin)}/</span>
                        {link.slug}
                    </h1>
                    <p className="destination">
                        {link.title && <strong>{link.title} </strong>}
                        <a href={link.url} target="_blank" rel="noreferrer">
                            {link.url}
                        </a>
                    </p>
                    <p className="link-meta">
                        <span>Created {formatDateTime(link.createdAt)}</span>
                        {link.expiresAt !== null && (
                            <span>Expires {formatDateTime(link.expiresAt)}</span>
                        )}
                        {/* Always there, so it can grow in and shrink away. */}
                        <span
                            className={
                                link.archived ? 'warn archived-flag' : 'warn archived-flag off'
                            }
                            aria-hidden={!link.archived}
                        >
                            Archived
                        </span>
                        {link.tags.map(t => (
                            <span key={t} className="tag">
                                {t}
                            </span>
                        ))}
                    </p>
                </div>
                <div className="link-header-actions">
                    <LinkActions
                        link={link}
                        onChanged={() => setVersion(v => v + 1)}
                        onDeleted={() => navigate('/links')}
                    />
                    <button
                        type="button"
                        className="text-button"
                        onClick={() => setWebhooksOpen(true)}
                    >
                        Webhooks
                    </button>
                    <button
                        type="button"
                        className="text-button"
                        onClick={() => void toggleArchived()}
                    >
                        <span
                            key={String(link.archived)}
                            className={
                                toggledFrom !== null && link.archived !== toggledFrom
                                    ? 'swap-in'
                                    : undefined
                            }
                        >
                            {link.archived ? 'Restore' : 'Archive'}
                        </span>
                    </button>
                </div>
            </header>
            <Analytics linkId={link.id} />
            {webhooksOpen && <LinkWebhooks link={link} onClose={() => setWebhooksOpen(false)} />}
        </main>
    );
}
