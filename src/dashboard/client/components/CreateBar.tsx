import { type FormEvent, useState } from 'react';

import type { Link } from '../../../shared/types.ts';
import { api, ApiRequestError } from '../api.ts';
import { hostOf } from '../format.ts';
import { useToast } from './Toast.tsx';

interface CreateBarProps {
    shortOrigin: string;
    initialUrl?: string;
    onCreated: (link: Link) => void;
}

export function CreateBar({ shortOrigin, initialUrl = '', onCreated }: CreateBarProps) {
    const toast = useToast();
    const [url, setUrl] = useState(initialUrl);
    const [slug, setSlug] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const link = await api.createLink({ url: url.trim(), slug: slug.trim() });
            const short = `${shortOrigin}/${link.slug}`;
            try {
                await navigator.clipboard.writeText(short);
                toast.show(`Copied ${hostOf(short)}`);
            } catch {
                toast.show(`Created ${hostOf(short)}`);
            }
            setUrl('');
            setSlug('');
            onCreated(link);
        } catch (error_) {
            setError(
                error_ instanceof ApiRequestError
                    ? (error_.issues?.[0]?.message ?? error_.message)
                    : String(error_)
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="create-bar" onSubmit={e => void submit(e)}>
            <label className="create-url">
                <span className="visually-hidden">Long URL</span>
                <input
                    type="url"
                    required
                    autoFocus
                    placeholder="Paste a long link"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                />
            </label>
            <label className="create-slug slug-input">
                <span className="slug-host">{hostOf(shortOrigin)}/</span>
                <span className="visually-hidden">Custom slug (optional)</span>
                <input
                    placeholder="random"
                    title="Leave empty for a random slug, or type / to make this the root link"
                    value={slug}
                    onChange={e => setSlug(e.target.value)}
                />
            </label>
            <button type="submit" className="button primary" disabled={busy}>
                Shorten
            </button>
            {error && <p className="error create-error">{error}</p>}
        </form>
    );
}
