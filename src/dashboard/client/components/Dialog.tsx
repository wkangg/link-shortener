import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState
} from 'react';

import { useReducedMotion } from '../motion.ts';

/** How long closing takes; matches `.dialog-closing` in styles.css. */
const CLOSE_MS = 160;

const DialogCloseContext = createContext<() => void>(() => {});

interface DialogProps {
    title: string;
    onClose: () => void;
    children: ReactNode;
    wide?: boolean;
}

/**
 * A native modal <dialog>: focus trapping, Esc and the backdrop come for free. It
 * animates in, and out when closed with ×, Esc, the backdrop or a `DialogClose` button.
 */
export function Dialog({ title, onClose, children, wide = false }: DialogProps) {
    const ref = useRef<HTMLDialogElement>(null);
    const reduce = useReducedMotion();
    const [closing, setClosing] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const dialog = ref.current;
        if (dialog && !dialog.open) dialog.showModal();
        return () => {
            // Closed some other way first (e.g. a second Esc): don't close the parent's next one.
            if (closeTimer.current) clearTimeout(closeTimer.current);
            dialog?.close();
        };
    }, []);

    // Plays the closing animation, then closes the dialog natively: its `close` event
    // unmounts it, and the browser returns focus to whatever opened it, which it skips
    // for a dialog that's already gone from the page.
    const close = useCallback(() => {
        const finish = () => ref.current?.close();
        if (reduce) {
            finish();
            return;
        }
        if (closing) return;
        setClosing(true);
        closeTimer.current = setTimeout(finish, CLOSE_MS);
    }, [closing, reduce]);

    const classes = ['dialog', wide && 'dialog-wide', closing && 'dialog-closing'];
    return (
        <dialog
            ref={ref}
            className={classes.filter(Boolean).join(' ')}
            aria-label={title}
            // No typing, clicking or submitting into a dialog that's on its way out.
            inert={closing}
            // Esc: animate out instead of the browser closing it at once.
            onCancel={event => {
                event.preventDefault();
                close();
            }}
            // Every close ends here, ours included.
            onClose={onClose}
            onClick={event => {
                if (event.target === ref.current) close();
            }}
        >
            <DialogCloseContext value={close}>
                <div className="dialog-body">
                    <header className="dialog-header">
                        <h2>{title}</h2>
                        <button
                            type="button"
                            className="icon-button"
                            aria-label="Close"
                            onClick={close}
                        >
                            ×
                        </button>
                    </header>
                    {children}
                </div>
            </DialogCloseContext>
        </dialog>
    );
}

/** A button that closes the dialog it's in, animating it out like ×. */
export function DialogClose({ className, children }: { className: string; children: ReactNode }) {
    const close = useContext(DialogCloseContext);
    return (
        <button type="button" className={className} onClick={close}>
            {children}
        </button>
    );
}
