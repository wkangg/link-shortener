import { type FormEvent, useState } from 'react';

import { isDiscordWebhookUrl } from '../../../shared/discord.ts';
import {
    DEFAULT_WEBHOOK_SKIP,
    WEBHOOK_SKIP_CATEGORIES,
    type WebhookEndpoint,
    type WebhookSkipCategory
} from '../../../shared/types.ts';
import { api, ApiRequestError } from '../api.ts';
import { Dialog, DialogClose } from './Dialog.tsx';
import { LinkPicker, type PickedLink } from './LinkPicker.tsx';
import { useToast } from './Toast.tsx';

export const SKIP_LABELS: Record<WebhookSkipCategory, string> = {
    bot: 'Bots and crawlers',
    datacenter: 'Datacenter and hosting IPs',
    scraper: 'Scrapers',
    abusive: 'Abusive IPs',
    vpn: 'VPN, Tor and relays'
};

export const KIND_LABELS = { standard: 'Signed JSON', discord: 'Discord' } as const;

interface WebhookEditorProps {
    /** null to add a new endpoint. */
    endpoint: WebhookEndpoint | null;
    /** A new endpoint starts out for just this link. */
    forLink?: PickedLink;
    onClose: () => void;
    onSaved: () => void;
}

export function WebhookEditor({ endpoint, forLink, onClose, onSaved }: WebhookEditorProps) {
    // A Discord URL comes back masked, so editing starts blank and keeps the old one.
    const [url, setUrl] = useState(endpoint?.kind === 'standard' ? endpoint.url : '');
    const [description, setDescription] = useState(endpoint?.description ?? '');
    const [allLinks, setAllLinks] = useState(endpoint ? endpoint.allLinks : !forLink);
    const [links, setLinks] = useState<PickedLink[]>(endpoint?.links ?? (forLink ? [forLink] : []));
    const [tags, setTags] = useState(endpoint?.tags.join(', ') ?? '');
    const [skip, setSkip] = useState<Set<WebhookSkipCategory>>(
        () => new Set(endpoint?.skip ?? DEFAULT_WEBHOOK_SKIP)
    );
    const [includeIp, setIncludeIp] = useState(endpoint?.includeIp ?? false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [secret, setSecret] = useState<string | null>(null);

    const kind = endpoint?.kind ?? (isDiscordWebhookUrl(url.trim()) ? 'discord' : 'standard');

    const save = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setErrors({});
        const fields = {
            description: description.trim() || null,
            allLinks,
            links: links.map(l => l.id),
            tags: tags
                .split(',')
                .map(t => t.trim())
                .filter(t => t !== ''),
            skip: WEBHOOK_SKIP_CATEGORIES.filter(c => skip.has(c)),
            includeIp
        };
        try {
            if (endpoint) {
                const changedUrl = url.trim() && url.trim() !== endpoint.url ? url.trim() : null;
                await api.updateWebhook(endpoint.id, {
                    ...fields,
                    ...(changedUrl && { url: changedUrl })
                });
                onSaved();
                onClose();
            } else {
                const created = await api.createWebhook({ url: url.trim(), ...fields });
                onSaved();
                if (created.secret) setSecret(created.secret);
                else onClose();
            }
        } catch (error) {
            if (error instanceof ApiRequestError) {
                const fieldErrors: Record<string, string> = { form: error.message };
                for (const issue of error.issues ?? []) {
                    fieldErrors[issue.path.split('.')[0] ?? issue.path] = issue.message;
                }
                setErrors(fieldErrors);
            } else {
                setErrors({ form: String(error) });
            }
        } finally {
            setSaving(false);
        }
    };

    if (secret) return <SecretDialog secret={secret} onClose={onClose} />;

    return (
        <Dialog title={endpoint ? 'Edit webhook' : 'Add a webhook'} onClose={onClose} wide>
            <form className="editor" onSubmit={e => void save(e)}>
                <label className="field">
                    <span>
                        URL{' '}
                        {(endpoint || url.trim()) && (
                            <span className="badge">{KIND_LABELS[kind]}</span>
                        )}
                    </span>
                    <input
                        type="url"
                        required={!endpoint}
                        value={url}
                        placeholder={
                            endpoint?.kind === 'discord'
                                ? `${endpoint.url} (leave blank to keep)`
                                : 'https://discord.com/api/webhooks/… or any https:// URL'
                        }
                        onChange={e => setUrl(e.target.value)}
                    />
                    {errors.url ? (
                        <small className="field-error">{errors.url}</small>
                    ) : (
                        <small className="muted">
                            {kind === 'discord'
                                ? 'Clicks arrive in the channel as embeds, batched to stay inside Discord’s rate limits.'
                                : 'Each click is POSTed as JSON, signed with Standard Webhooks. Paste a Discord webhook URL to post to a channel instead.'}
                        </small>
                    )}
                </label>
                <label className="field">
                    <span>Description</span>
                    <input
                        value={description}
                        placeholder="Optional, e.g. #clicks channel"
                        onChange={e => setDescription(e.target.value)}
                    />
                </label>
                <fieldset className="webhook-scope">
                    <legend>Send clicks on</legend>
                    <label className="checkbox">
                        <input
                            type="radio"
                            name="scope"
                            checked={allLinks}
                            onChange={() => setAllLinks(true)}
                        />
                        Every link
                    </label>
                    <label className="checkbox">
                        <input
                            type="radio"
                            name="scope"
                            checked={!allLinks}
                            onChange={() => setAllLinks(false)}
                        />
                        Only the links I choose
                    </label>
                    {!allLinks && (
                        <div className="webhook-scope-links">
                            <LinkPicker value={links} onChange={setLinks} />
                            <label className="field">
                                <span>And any link tagged</span>
                                <input
                                    value={tags}
                                    placeholder="Optional, e.g. promo, launch"
                                    onChange={e => setTags(e.target.value)}
                                />
                                {errors.tags && (
                                    <small className="field-error">{errors.tags}</small>
                                )}
                            </label>
                            {links.length === 0 && !tags.trim() && (
                                <small className="warn">
                                    No links chosen yet, so nothing will be sent. You can also turn
                                    links on from each link’s page.
                                </small>
                            )}
                        </div>
                    )}
                </fieldset>
                <fieldset className="webhook-skip">
                    <legend>Don’t send clicks from</legend>
                    {WEBHOOK_SKIP_CATEGORIES.map(category => (
                        <label className="checkbox" key={category}>
                            <input
                                type="checkbox"
                                checked={skip.has(category)}
                                onChange={e => {
                                    const checked = e.target.checked;
                                    setSkip(current => {
                                        const next = new Set(current);
                                        if (checked) next.add(category);
                                        else next.delete(category);
                                        return next;
                                    });
                                }}
                            />
                            {SKIP_LABELS[category]}
                        </label>
                    ))}
                    <small className="muted">
                        Datacenter, scraper and abuse verdicts can take a few seconds, so skipping
                        any of them delays each click by 10 seconds.
                    </small>
                </fieldset>
                <label className="checkbox track-device">
                    <input
                        type="checkbox"
                        checked={includeIp}
                        onChange={e => setIncludeIp(e.target.checked)}
                    />
                    <span>
                        Include IP address and user agent
                        <small>
                            {kind === 'discord'
                                ? 'Everyone who can read the channel will see them.'
                                : 'Off by default: only coarse location, device and source leave the server.'}
                        </small>
                    </span>
                </label>
                {errors.form && <p className="error">{errors.form}</p>}
                <div className="button-row spread">
                    <span />
                    <span className="button-row">
                        <DialogClose className="button">Cancel</DialogClose>
                        <button type="submit" className="button primary" disabled={saving}>
                            {saving ? 'Saving…' : endpoint ? 'Save changes' : 'Add webhook'}
                        </button>
                    </span>
                </div>
            </form>
        </Dialog>
    );
}

/** Shows a signing secret once, with a copy button. */
export function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
    const toast = useToast();
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(secret);
            toast.show('Copied secret');
        } catch {
            toast.show('Clipboard is not available here');
        }
    };
    return (
        <Dialog title="Signing secret" onClose={onClose}>
            <p>
                Verify each request’s <code>webhook-signature</code> header with this secret. It
                won’t be shown again; rotate it to get a new one.
            </p>
            <pre className="code">{secret}</pre>
            <div className="button-row spread">
                <button type="button" className="button" onClick={() => void copy()}>
                    Copy secret
                </button>
                <DialogClose className="button primary">Done</DialogClose>
            </div>
        </Dialog>
    );
}
