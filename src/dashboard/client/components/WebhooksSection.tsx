import { useState } from 'react';

import type { WebhookEndpoint, WebhookSkipCategory } from '../../../shared/types.ts';
import { api, ApiRequestError } from '../api.ts';
import { formatCount, formatDateTime, formatRelative } from '../format.ts';
import { useApi } from '../useApi.ts';
import { useToast } from './Toast.tsx';
import { KIND_LABELS, SecretDialog, WebhookEditor } from './WebhookEditor.tsx';
import { WebhookLog } from './WebhookLog.tsx';

/** The skip categories as they read mid-sentence. */
const SKIP_SUMMARY: Record<WebhookSkipCategory, string> = {
    bot: 'bots',
    datacenter: 'datacenter IPs',
    scraper: 'scrapers',
    abusive: 'abusive IPs',
    vpn: 'VPNs'
};

type Open =
    | { kind: 'editor'; endpoint: WebhookEndpoint | null }
    | { kind: 'log'; endpoint: WebhookEndpoint }
    | { kind: 'secret'; secret: string };

/** Settings → Webhooks: the endpoints, their health and their actions. */
export function WebhooksSection() {
    const toast = useToast();
    const [version, setVersion] = useState(0);
    const [open, setOpen] = useState<Open | null>(null);
    const endpoints = useApi(`webhooks:${version}`, () => api.webhooks());
    const reload = () => setVersion(v => v + 1);

    const act = async (run: () => Promise<unknown>, done: string) => {
        try {
            await run();
            toast.show(done);
            reload();
        } catch (error) {
            toast.show(error instanceof ApiRequestError ? error.message : String(error));
        }
    };

    return (
        <section>
            <h2>Webhooks</h2>
            <p>
                Send every click somewhere else as it happens: a Discord channel, or any URL that
                accepts JSON (Zapier, n8n, your own server). Each endpoint has its own filters, and
                failed deliveries are retried for about a day.
            </p>

            {endpoints.error && <p className="error">{endpoints.error.message}</p>}
            {endpoints.data && endpoints.data.length > 0 && (
                <ul className="webhook-list">
                    {endpoints.data.map(endpoint => (
                        <WebhookRow
                            key={endpoint.id}
                            endpoint={endpoint}
                            onEdit={() => setOpen({ kind: 'editor', endpoint })}
                            onLog={() => setOpen({ kind: 'log', endpoint })}
                            onToggle={enabled =>
                                void act(
                                    () => api.updateWebhook(endpoint.id, { enabled }),
                                    enabled ? 'Webhook on' : 'Webhook off'
                                )
                            }
                            onTest={() =>
                                void act(
                                    () => api.testWebhook(endpoint.id),
                                    'Test event queued; check the delivery log'
                                ).then(() => {
                                    // It goes out within a second or two; show how it went.
                                    setTimeout(reload, 2500);
                                })
                            }
                            onRotate={() =>
                                void (async () => {
                                    try {
                                        const { secret } = await api.rotateWebhookSecret(
                                            endpoint.id
                                        );
                                        setOpen({ kind: 'secret', secret });
                                    } catch (error) {
                                        toast.show(String(error));
                                    }
                                })()
                            }
                            onDelete={() =>
                                void act(() => api.deleteWebhook(endpoint.id), 'Webhook deleted')
                            }
                        />
                    ))}
                </ul>
            )}
            <button
                type="button"
                className="button small"
                onClick={() => setOpen({ kind: 'editor', endpoint: null })}
            >
                Add webhook
            </button>

            {open?.kind === 'editor' && (
                <WebhookEditor
                    endpoint={open.endpoint}
                    onClose={() => setOpen(null)}
                    onSaved={reload}
                />
            )}
            {open?.kind === 'log' && (
                <WebhookLog
                    endpoint={open.endpoint}
                    onClose={() => {
                        setOpen(null);
                        reload();
                    }}
                />
            )}
            {open?.kind === 'secret' && (
                <SecretDialog secret={open.secret} onClose={() => setOpen(null)} />
            )}
        </section>
    );
}

interface WebhookRowProps {
    endpoint: WebhookEndpoint;
    onEdit: () => void;
    onLog: () => void;
    onToggle: (enabled: boolean) => void;
    onTest: () => void;
    onRotate: () => void;
    onDelete: () => void;
}

/** "All links", "Only /a, /b and links tagged promo", "No links chosen yet". */
function scopeSummary(endpoint: WebhookEndpoint): string {
    if (endpoint.allLinks) return 'All links';
    const shown = endpoint.links.slice(0, 5).map(l => `/${l.slug}`);
    const more = endpoint.links.length - shown.length;
    const parts = [
        shown.length > 0 ? shown.join(', ') + (more > 0 ? ` and ${more} more` : '') : null,
        endpoint.tags.length > 0 ? `links tagged ${endpoint.tags.join(', ')}` : null
    ].filter(Boolean);
    return parts.length > 0 ? `Only ${parts.join(' and ')}` : 'No links chosen yet';
}

function health(endpoint: WebhookEndpoint): { text: string; tone: 'ok' | 'warn' | 'muted' } {
    if (!endpoint.enabled) {
        return endpoint.disabledReason
            ? { text: `Turned off: ${endpoint.disabledReason}`, tone: 'warn' }
            : { text: 'Off', tone: 'muted' };
    }
    if (endpoint.failingSince !== null) {
        const error = endpoint.lastEvent?.error;
        return {
            text: `Failing since ${formatRelative(endpoint.failingSince)}${error ? `: ${error}` : ''}`,
            tone: 'warn'
        };
    }
    const last = endpoint.lastEvent;
    if (!last) return { text: 'Nothing sent yet', tone: 'muted' };
    return last.status === 'delivered'
        ? { text: `Last delivered ${formatRelative(last.at)}`, tone: 'ok' }
        : {
              text: `Last failed ${formatRelative(last.at)}: ${last.error ?? 'error'}`,
              tone: 'warn'
          };
}

function WebhookRow(props: WebhookRowProps) {
    const { endpoint } = props;
    const [confirm, setConfirm] = useState<'delete' | 'rotate' | null>(null);
    const status = health(endpoint);
    const { pending, delivered, skipped, failed } = endpoint.counts;
    const filters = [
        scopeSummary(endpoint),
        endpoint.skip.length > 0
            ? `skipping ${endpoint.skip.map(s => SKIP_SUMMARY[s]).join(', ')}`
            : 'nothing skipped',
        endpoint.includeIp ? 'with IP addresses' : null
    ].filter(Boolean);

    return (
        <li className="webhook">
            <div className="webhook-head">
                <div className="webhook-title">
                    <strong>{endpoint.description ?? KIND_LABELS[endpoint.kind]}</strong>
                    <span className="badge">{KIND_LABELS[endpoint.kind]}</span>
                </div>
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={endpoint.enabled}
                        onChange={e => props.onToggle(e.target.checked)}
                    />
                    On
                </label>
            </div>
            <code className="webhook-url">{endpoint.url}</code>
            <p className={`webhook-health ${status.tone}`}>{status.text}</p>
            <p className="muted webhook-meta">
                {filters.join(', ')}. In the last 7 days: {formatCount(delivered)} delivered,{' '}
                {formatCount(skipped)} skipped, {formatCount(failed)} failed
                {pending > 0 && `, ${formatCount(pending)} queued`}. Added{' '}
                <span title={formatDateTime(endpoint.createdAt)}>
                    {formatRelative(endpoint.createdAt)}
                </span>
                .
            </p>
            {confirm ? (
                <span className="confirm">
                    {confirm === 'delete'
                        ? 'Delete this webhook and its delivery log?'
                        : 'Make a new secret? The current one stops working right away.'}
                    <button
                        type="button"
                        className={confirm === 'delete' ? 'button small danger' : 'button small'}
                        onClick={() => {
                            setConfirm(null);
                            if (confirm === 'delete') props.onDelete();
                            else props.onRotate();
                        }}
                    >
                        {confirm === 'delete' ? 'Delete' : 'Rotate secret'}
                    </button>
                    <button type="button" className="button small" onClick={() => setConfirm(null)}>
                        Cancel
                    </button>
                </span>
            ) : (
                <div className="button-row">
                    <button
                        type="button"
                        className="button small"
                        disabled={!endpoint.enabled}
                        onClick={props.onTest}
                    >
                        Send test
                    </button>
                    <button type="button" className="button small" onClick={props.onLog}>
                        Delivery log
                    </button>
                    <button type="button" className="button small" onClick={props.onEdit}>
                        Edit
                    </button>
                    {endpoint.kind === 'standard' && (
                        <button
                            type="button"
                            className="text-button"
                            onClick={() => setConfirm('rotate')}
                        >
                            Rotate secret
                        </button>
                    )}
                    <button
                        type="button"
                        className="text-button danger"
                        onClick={() => setConfirm('delete')}
                    >
                        Delete
                    </button>
                </div>
            )}
        </li>
    );
}
