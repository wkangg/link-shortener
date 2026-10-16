import { useState } from 'react';

import type { Link } from '../../../shared/types.ts';
import { useConfig } from '../config.tsx';
import { hostOf } from '../format.ts';
import { LinkEditor } from './LinkEditor.tsx';
import { QrDialog } from './QrDialog.tsx';
import { useToast } from './Toast.tsx';

interface LinkActionsProps {
    link: Link;
    onChanged: (link: Link) => void;
    onDeleted: (link: Link) => void;
}

/** Copies text to the clipboard and confirms with a toast. */
export function useCopy() {
    const toast = useToast();
    return async (text: string, message: string) => {
        try {
            await navigator.clipboard.writeText(text);
            toast.show(message);
        } catch {
            toast.show('Clipboard is not available here');
        }
    };
}

/** Copy, QR and Edit for one link, with the dialogs they open. */
export function LinkActions({ link, onChanged, onDeleted }: LinkActionsProps) {
    const { shortOrigin } = useConfig();
    const toast = useToast();
    const copy = useCopy();
    const [open, setOpen] = useState<'qr' | 'edit' | null>(null);
    const shortUrl = `${shortOrigin}/${link.slug}`;

    return (
        <div className="link-actions">
            <button
                type="button"
                className="button small"
                onClick={() => void copy(shortUrl, `Copied ${hostOf(shortUrl)}`)}
            >
                Copy
            </button>
            <button type="button" className="button small" onClick={() => setOpen('qr')}>
                QR
            </button>
            <button type="button" className="button small" onClick={() => setOpen('edit')}>
                Edit
            </button>
            {open === 'qr' && (
                <QrDialog shortUrl={shortUrl} slug={link.slug} onClose={() => setOpen(null)} />
            )}
            {open === 'edit' && (
                <LinkEditor
                    link={link}
                    shortOrigin={shortOrigin}
                    onClose={() => setOpen(null)}
                    onSaved={saved => {
                        setOpen(null);
                        toast.show('Changes saved');
                        onChanged(saved);
                    }}
                    onDeleted={deleted => {
                        setOpen(null);
                        toast.show(`Deleted /${deleted.slug}`);
                        onDeleted(deleted);
                    }}
                />
            )}
        </div>
    );
}
