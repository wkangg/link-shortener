import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

interface ToastContextValue {
    show: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
    const [message, setMessage] = useState<{ text: string; id: number } | null>(null);

    const show = useCallback((text: string) => {
        const id = Date.now();
        setMessage({ text, id });
        setTimeout(() => setMessage(current => (current?.id === id ? null : current)), 2500);
    }, []);
    const value = useMemo(() => ({ show }), [show]);

    return (
        <ToastContext value={value}>
            {children}
            <div className="toast-region" role="status" aria-live="polite">
                {message && <div className="toast">{message.text}</div>}
            </div>
        </ToastContext>
    );
}

export const useToast = () => useContext(ToastContext);
