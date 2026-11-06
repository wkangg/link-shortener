import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState
} from 'react';

import { useReducedMotion } from '../motion.ts';

interface ToastContextValue {
    show: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ show: () => {} });

const VISIBLE_MS = 2500;
/** How long the toast takes to leave; matches `.toast-leaving` in styles.css. */
const LEAVE_MS = 200;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [message, setMessage] = useState<{ text: string; id: number; leaving: boolean } | null>(
        null
    );

    // Unique per toast, unlike a timestamp, so timers and keys never mix up two toasts.
    const lastId = useRef(0);
    const reduce = useReducedMotion();

    const show = useCallback(
        (text: string) => {
            const id = ++lastId.current;
            setMessage({ text, id, leaving: false });
            const remove = () => setMessage(current => (current?.id === id ? null : current));
            // With reduced motion there's no exit animation to wait for.
            if (reduce) {
                setTimeout(remove, VISIBLE_MS);
                return;
            }
            setTimeout(() => {
                setMessage(current =>
                    current?.id === id ? { ...current, leaving: true } : current
                );
            }, VISIBLE_MS);
            setTimeout(remove, VISIBLE_MS + LEAVE_MS);
        },
        [reduce]
    );
    const value = useMemo(() => ({ show }), [show]);

    return (
        <ToastContext value={value}>
            {children}
            <div className="toast-region" role="status" aria-live="polite">
                {/* Keyed so a new message animates in rather than swapping text in place. */}
                {message && (
                    <div
                        key={message.id}
                        className={message.leaving ? 'toast toast-leaving' : 'toast'}
                    >
                        {message.text}
                    </div>
                )}
            </div>
        </ToastContext>
    );
}

export const useToast = () => useContext(ToastContext);
