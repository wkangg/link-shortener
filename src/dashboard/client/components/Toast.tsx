import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState
} from 'react';

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

    const show = useCallback((text: string) => {
        const id = ++lastId.current;
        setMessage({ text, id, leaving: false });
        setTimeout(() => {
            setMessage(current => (current?.id === id ? { ...current, leaving: true } : current));
        }, VISIBLE_MS);
        setTimeout(() => {
            setMessage(current => (current?.id === id ? null : current));
        }, VISIBLE_MS + LEAVE_MS);
    }, []);
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
