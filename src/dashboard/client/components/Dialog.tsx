import {
    createContext,
    type ReactNode,
    type Ref,
    useCallback,
    useContext,
    useEffect,
    useImperativeHandle,
    useRef,
    useState
} from 'react';

import { useReducedMotion } from '../motion.ts';

/** How long closing takes; matches `.dialog-closing` in styles.css. */
const CLOSE_MS = 160;

const DialogCloseContext = createContext<() => void>(() => {});

/** Lets the component that renders a dialog close it the animated way, e.g. after a save. */
export interface DialogHandle {
    close: () => void;
}

interface DialogProps {
    title: string;
    onClose: () => void;
    children: ReactNode;
    wide?: boolean;
    ref?: Ref<DialogHandle>;
}

/**
 * A native modal <dialog>: focus trapping, Esc and the backdrop come for free. It
 * animates in, and out when closed with ×, Esc, the backdrop or a `DialogClose` button.
 */
export function Dialog({ title, onClose, children, wide = false, ref: handle }: DialogProps) {
    const ref = useRef<HTMLDialogElement>(null);
    const reduce = useReducedMotion();
    const [closing, setClosing] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Set once we've closed it ourselves, so its later `close` event doesn't call onClose twice.
    const closedByUs = useRef(false);

    useEffect(() => {
        const dialog = ref.current;
        if (dialog && !dialog.open) dialog.showModal();
        return () => {
            // Closed some other way first (e.g. a second Esc): don't close the parent's next one.
            if (closeTimer.current) clearTimeout(closeTimer.current);
            dialog?.close();
        };
    }, []);

    // Plays the closing animation, then closes the dialog natively while it's still on the
    // page, so the browser returns focus to whatever opened it (it skips that for a dialog
    // that's already gone), and only then lets the parent unmount it. The parent is told
    // directly rather than through the `close` event, which some browsers deliver late.
    const close = useCallback(() => {
        const finish = () => {
            closedByUs.current = true;
            ref.current?.close();
            onClose();
        };
        if (reduce) {
            finish();
            return;
        }
        if (closing) return;
        setClosing(true);
        closeTimer.current = setTimeout(finish, CLOSE_MS);
    }, [closing, onClose, reduce]);
    useImperativeHandle(handle, () => ({ close }), [close]);

    const classes = ['dialog', wide && 'dialog-wide', closing && 'dialog-closing'];
    return (
        <dialog
            ref={ref}
            className={classes.filter(Boolean).join(' ')}
            aria-label={title}
            // No typing, clicking or submitting into a dialog that's on its way out.
            inert={closing}
            // Esc: animate out instead of the browser closing it at once. React passes
            // cancel and close up from children (a nested dialog, a file picker), so act
            // only on this dialog's own.
            onCancel={event => {
                if (event.target !== event.currentTarget) return;
                event.preventDefault();
                close();
            }}
            // Closes we didn't start, e.g. a second Esc that the browser won't let us cancel.
            onClose={event => {
                if (event.target === event.currentTarget && !closedByUs.current) onClose();
            }}
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
