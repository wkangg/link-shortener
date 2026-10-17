import { useState } from 'react';

import type { Link, WebhookEndpoint } from '../../../shared/types.ts';
import { api, ApiRequestError } from '../api.ts';
import { linkClick } from '../router.ts';
import { useApi } from '../useApi.ts';
import { Dialog } from './Dialog.tsx';
import { useToast } from './Toast.tsx';
import { KIND_LABELS, WebhookEditor } from './WebhookEditor.tsx';

/** Whether an endpoint gets this link's clicks, and whether that can be changed here. */
function coverage(endpoint: WebhookEndpoint, link: Link): { on: boolean; fixed: string | null } {
    if (endpoint.allLinks) return { on: true, fixed: 'Every link' };
    const tag = endpoint.tags.find(t => link.tags.includes(t));
    if (tag) return { on: true, fixed: `Tagged ${tag}` };
    return { on: endpoint.links.some(l => l.id === link.id), fixed: null };
}

/** Which webhooks get this link's clicks, with a switch for each. */
export function LinkWebhooks({ link, onClose }: { link: Link; onClose: () => void }) {
    const toast = useToast();
    const [version, setVersion] = useState(0);
    const [adding, setAdding] = useState(false);
    const endpoints = useApi(`webhooks:${version}`, () => api.webhooks());

    const toggle = async (endpoint: WebhookEndpoint, on: boolean) => {
        try {
            await api.setWebhookLink(endpoint.id, link.id, on);
            toast.show(
                on ? 'Clicks on this link will be sent' : 'Clicks on this link won’t be sent'
            );
            setVersion(v => v + 1);
        } catch (error) {
            toast.show(error instanceof ApiRequestError ? error.message : String(error));
        }
    };

    if (adding) {
        return (
            <WebhookEditor
                endpoint={null}
                forLink={{ id: link.id, slug: link.slug }}
                onClose={() => setAdding(false)}
                onSaved={() => setVersion(v => v + 1)}
            />
        );
    }

    return (
        <Dialog title={`Webhooks for /${link.slug}`} onClose={onClose}>
            <p className="muted">Send this link’s clicks to:</p>
            {endpoints.error && <p className="error">{endpoints.error.message}</p>}
            {endpoints.data?.length === 0 && <p className="empty">No webhooks yet.</p>}
            {endpoints.data && endpoints.data.length > 0 && (
                <ul className="link-webhooks">
                    {endpoints.data.map(endpoint => {
                        const { on, fixed } = coverage(endpoint, link);
                        return (
                            <li key={endpoint.id}>
                                <label className="checkbox">
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        disabled={fixed !== null}
                                        onChange={e => void toggle(endpoint, e.target.checked)}
                                    />
                                    <span>
                                        {endpoint.description ?? endpoint.url}
                                        <span className="badge">{KIND_LABELS[endpoint.kind]}</span>
                                        {!endpoint.enabled && <span className="badge">Off</span>}
                                        {fixed && <small>{fixed}: change it in Settings</small>}
                                    </span>
                                </label>
                            </li>
                        );
                    })}
                </ul>
            )}
            <div className="button-row spread">
                <a href="/settings" onClick={linkClick}>
                    Manage webhooks
                </a>
                <button type="button" className="button primary" onClick={() => setAdding(true)}>
                    Add a webhook for this link
                </button>
            </div>
        </Dialog>
    );
}
