import { type ReactNode, useEffect, useRef } from 'react';

interface DialogProps {
    title: string;
    onClose: () => void;
    children: ReactNode;
    wide?: boolean;
}

/** A native modal <dialog>: focus trapping, Esc and the backdrop come for free. */
export function Dialog({ title, onClose, children, wide = false }: DialogProps) {
    const ref = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const dialog = ref.current;
        if (dialog && !dialog.open) dialog.showModal();
        return () => dialog?.close();
    }, []);

    return (
        <dialog
            ref={ref}
            className={wide ? 'dialog dialog-wide' : 'dialog'}
            aria-label={title}
            onClose={onClose}
            onClick={event => {
                if (event.target === ref.current) onClose();
            }}
        >
            <div className="dialog-body">
                <header className="dialog-header">
                    <h2>{title}</h2>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Close"
                        onClick={onClose}
                    >
                        ×
                    </button>
                </header>
                {children}
            </div>
        </dialog>
    );
}
