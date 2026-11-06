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

    const list = endpoints.data;

    return (
        <Dialog title={`Webhooks for /${link.slug}`} onClose={onClose}>
            {endpoints.error && <p className="error">{endpoints.error.message}</p>}
            {list?.length === 0 && (
                <p className="link-webhooks-intro">
                    A webhook sends this link’s clicks somewhere else, such as a Discord channel or
                    your own server. You haven’t set one up yet.
                </p>
            )}
            {list && list.length > 0 && (
                <p className="link-webhooks-intro muted">Send this link’s clicks to:</p>
            )}
            {list && list.length > 0 && (
                <ul className="link-webhooks">
                    {list.map(endpoint => {
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
                    All webhooks in Settings
                </a>
                <button type="button" className="button primary" onClick={() => setAdding(true)}>
                    Add webhook
                </button>
            </div>
        </Dialog>
    );
}
