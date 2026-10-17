import { useState } from 'react';

import type { WebhookEndpoint, WebhookEventRow } from '../../../shared/types.ts';
import { api, ApiRequestError } from '../api.ts';
import { formatDateTime, formatRelative } from '../format.ts';
import { useApi } from '../useApi.ts';
import { Dialog } from './Dialog.tsx';
import { useToast } from './Toast.tsx';

const STATUS_LABELS: Record<WebhookEventRow['status'], string> = {
    pending: 'Queued',
    delivered: 'Delivered',
    skipped: 'Skipped',
    failed: 'Failed'
};

function result(event: WebhookEventRow): string {
    const parts = [
        event.httpStatus === null ? null : `HTTP ${event.httpStatus}`,
        event.error && event.error !== `HTTP ${event.httpStatus}` ? event.error : null
    ].filter(Boolean);
    if (event.status === 'pending' && event.attempts > 0) {
        parts.push(`retrying ${formatRelative(event.dueAt)}`);
    }
    return parts.join(' · ') || '—';
}

/** The latest events for one endpoint, with retry for finished ones. */
export function WebhookLog({
    endpoint,
    onClose
}: {
    endpoint: WebhookEndpoint;
    onClose: () => void;
}) {
    const toast = useToast();
    const [version, setVersion] = useState(0);
    const events = useApi(`webhook-events:${endpoint.id}:${version}`, () =>
        api.webhookEvents(endpoint.id)
    );

    const retry = async (event: WebhookEventRow) => {
        try {
            await api.retryWebhookEvent(event.id);
            toast.show('Queued to send again');
            setVersion(v => v + 1);
        } catch (error) {
            toast.show(error instanceof ApiRequestError ? error.message : String(error));
        }
    };

    return (
        <Dialog
            title={`Deliveries: ${endpoint.description ?? endpoint.url}`}
            onClose={onClose}
            wide
        >
            <div className="button-row spread webhook-log-bar">
                <small className="muted">
                    The last 50 events. Finished ones are kept for 7 days.
                </small>
                <button
                    type="button"
                    className="button small"
                    onClick={() => setVersion(v => v + 1)}
                >
                    Refresh
                </button>
            </div>
            {events.error && <p className="error">{events.error.message}</p>}
            {events.data?.length === 0 && <p className="empty">Nothing sent yet.</p>}
            {events.data && events.data.length > 0 && (
                <div className="history-scroll">
                    <table className="history-table">
                        <thead>
                            <tr>
                                <th>When</th>
                                <th>Event</th>
                                <th>Status</th>
                                <th className="numeric">Tries</th>
                                <th>Result</th>
                                <th>
                                    <span className="visually-hidden">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {events.data.map(event => (
                                <tr key={event.id}>
                                    <td className="nowrap" title={formatDateTime(event.createdAt)}>
                                        {formatRelative(event.createdAt)}
                                    </td>
                                    <td className="nowrap">
                                        {event.type === 'webhook.test'
                                            ? 'Test'
                                            : `Click #${event.clickId ?? '?'}`}
                                    </td>
                                    <td>
                                        <span className={`badge webhook-status-${event.status}`}>
                                            {STATUS_LABELS[event.status]}
                                        </span>
                                    </td>
                                    <td className="numeric">{event.attempts}</td>
                                    <td className="webhook-result">{result(event)}</td>
                                    <td>
                                        {(event.status === 'failed' ||
                                            event.status === 'skipped') && (
                                            <button
                                                type="button"
                                                className="text-button"
                                                disabled={!endpoint.enabled}
                                                onClick={() => void retry(event)}
                                            >
                                                Send again
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Dialog>
    );
}
