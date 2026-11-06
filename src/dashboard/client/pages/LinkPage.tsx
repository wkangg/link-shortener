import { useEffect, useState } from 'react';

import { api } from '../api.ts';
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
    const { data: link, error } = useApi(`${id}|${version}`, () => api.link(id));
    const slug = link?.slug;

    // Replaces App's "Link · …" placeholder once the slug is known: "nl-oct · s.example".
    useEffect(() => {
        if (slug !== undefined) document.title = pageTitle(slug, shortOrigin);
    }, [slug, shortOrigin]);

    if (error) {
        return (
            <main className="page">
                <p className="error">This link doesn’t exist any more.</p>
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
                        {link.archived && <span className="warn">Archived</span>}
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
                        {link.archived ? 'Restore' : 'Archive'}
                    </button>
                </div>
            </header>
            <Analytics linkId={link.id} />
            {webhooksOpen && <LinkWebhooks link={link} onClose={() => setWebhooksOpen(false)} />}
        </main>
    );
}
