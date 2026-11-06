import { type FormEvent, useRef, useState } from 'react';

import type { Link, RedirectType } from '../../../shared/types.ts';
import { api, ApiRequestError } from '../api.ts';
import { hostOf } from '../format.ts';
import { Dialog, DialogClose, type DialogHandle } from './Dialog.tsx';

const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

interface LinkEditorProps {
    link: Link;
    shortOrigin: string;
    onClose: () => void;
    onSaved: (link: Link) => void;
    onDeleted: (link: Link) => void;
}

function toLocalInput(ms: number | null): string {
    if (ms === null) return '';
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
    return d.toISOString().slice(0, 16);
}

function utmOf(url: string): Record<string, string> {
    try {
        const params = new URL(url).searchParams;
        return Object.fromEntries(UTM_FIELDS.map(k => [k, params.get(k) ?? '']));
    } catch {
        return Object.fromEntries(UTM_FIELDS.map(k => [k, '']));
    }
}

function withUtm(url: string, utm: Record<string, string>): string {
    try {
        const u = new URL(url);
        for (const key of UTM_FIELDS) {
            const value = utm[key]?.trim() ?? '';
            if (value) u.searchParams.set(key, value);
            else u.searchParams.delete(key);
        }
        return u.href;
    } catch {
        return url;
    }
}

export function LinkEditor({ link, shortOrigin, onClose, onSaved, onDeleted }: LinkEditorProps) {
    const [url, setUrl] = useState(link.url);
    // The root link has an empty slug; it's typed as `/`.
    const [slug, setSlug] = useState(link.slug || '/');
    const [title, setTitle] = useState(link.title ?? '');
    const [tags, setTags] = useState(link.tags.join(', '));
    const [redirectType, setRedirectType] = useState<RedirectType>(link.redirectType);
    const [expires, setExpires] = useState(toLocalInput(link.expiresAt));
    const [trackDevice, setTrackDevice] = useState(link.trackDevice);
    const [utm, setUtm] = useState(() => utmOf(link.url));
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const dialog = useRef<DialogHandle>(null);

    const save = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setErrors({});
        try {
            const saved = await api.updateLink(link.id, {
                url: withUtm(url.trim(), utm),
                slug: slug.trim(),
                title: title.trim() || null,
                tags: tags
                    .split(',')
                    .map(t => t.trim())
                    .filter(t => t !== ''),
                redirectType,
                trackDevice,
                expiresAt: expires ? new Date(expires).getTime() : null
            });
            onSaved(saved);
            // Animates out like Cancel; its onClose then unmounts it.
            dialog.current?.close();
        } catch (error) {
            if (error instanceof ApiRequestError) {
                const fieldErrors: Record<string, string> = { form: error.message };
                for (const issue of error.issues ?? []) fieldErrors[issue.path] = issue.message;
                setErrors(fieldErrors);
            } else {
                setErrors({ form: String(error) });
            }
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        await api.deleteLink(link.id);
        onDeleted(link);
    };

    return (
        <Dialog
            ref={dialog}
            title={`Edit ${hostOf(shortOrigin)}/${link.slug}`}
            onClose={onClose}
            wide
        >
            <form className="editor" onSubmit={e => void save(e)}>
                <label className="field">
                    <span>Destination</span>
                    <input type="url" required value={url} onChange={e => setUrl(e.target.value)} />
                    {errors.url && <small className="field-error">{errors.url}</small>}
                </label>
                <div className="field-row">
                    <label className="field">
                        <span>Short link</span>
                        <span className="slug-input">
                            <span className="slug-host">{hostOf(shortOrigin)}/</span>
                            <input value={slug} onChange={e => setSlug(e.target.value)} />
                        </span>
                        {errors.slug && <small className="field-error">{errors.slug}</small>}
                    </label>
                    <label className="field">
                        <span>Title</span>
                        <input
                            value={title}
                            placeholder="Optional"
                            onChange={e => setTitle(e.target.value)}
                        />
                    </label>
                </div>
                <label className="field">
                    <span>Tags</span>
                    <input
                        value={tags}
                        placeholder="work, side-project"
                        onChange={e => setTags(e.target.value)}
                    />
                    {errors.tags && <small className="field-error">{errors.tags}</small>}
                </label>
                <fieldset className="utm">
                    <legend>UTM parameters added to the destination</legend>
                    {UTM_FIELDS.map(key => (
                        <label className="field" key={key}>
                            <span>{key}</span>
                            <input
                                value={utm[key] ?? ''}
                                onChange={e => {
                                    const value = e.target.value;
                                    setUtm(current => ({ ...current, [key]: value }));
                                }}
                            />
                        </label>
                    ))}
                </fieldset>
                <div className="field-row">
                    <label className="field field-expires">
                        <span>Expires</span>
                        <input
                            type="datetime-local"
                            value={expires}
                            onChange={e => setExpires(e.target.value)}
                        />
                    </label>
                    <label className="field field-redirect">
                        <span>Redirect type</span>
                        <select
                            value={redirectType}
                            onChange={e => setRedirectType(Number(e.target.value) as RedirectType)}
                        >
                            <option value={302}>302 temporary (every click counted)</option>
                            <option value={307}>307 temporary, keeps method</option>
                            <option value={301}>
                                301 permanent (browsers cache it, undercounts)
                            </option>
                            <option value={308}>308 permanent, keeps method</option>
                        </select>
                    </label>
                </div>
                <label className="checkbox track-device">
                    <input
                        type="checkbox"
                        checked={trackDevice}
                        onChange={e => setTrackDevice(e.target.checked)}
                    />
                    <span>
                        Detailed device tracking
                        <small>
                            Shows a brief redirect page that records battery, screen, GPU,
                            connection and more before forwarding. Adds a short delay; bots still
                            get a plain redirect.
                        </small>
                    </span>
                </label>
                {errors.form && <p className="error">{errors.form}</p>}
                <div className="button-row spread">
                    {confirmDelete ? (
                        <span className="confirm">
                            Delete this link and all its clicks?
                            <button
                                type="button"
                                className="button danger"
                                onClick={() => void remove()}
                            >
                                Delete
                            </button>
                            <button
                                type="button"
                                className="button"
                                onClick={() => setConfirmDelete(false)}
                            >
                                Keep
                            </button>
                        </span>
                    ) : (
                        <button
                            type="button"
                            className="text-button danger"
                            onClick={() => setConfirmDelete(true)}
                        >
                            Delete link
                        </button>
                    )}
                    <span className="button-row">
                        <DialogClose className="button">Cancel</DialogClose>
                        <button type="submit" className="button primary" disabled={saving}>
                            {saving ? 'Saving…' : 'Save changes'}
                        </button>
                    </span>
                </div>
            </form>
        </Dialog>
    );
}
