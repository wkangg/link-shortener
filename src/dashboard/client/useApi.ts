import { useEffect, useState } from 'react';

export interface ApiState<T> {
    data: T | undefined;
    error: Error | undefined;
    loading: boolean;
}

interface Settled<T> {
    key: string;
    data?: T;
    error?: Error;
}

/**
 * Fetches whenever `key` changes. The previous data stays visible while the
 * next request is in flight, so filters don't flash the page empty.
 */
export function useApi<T>(key: string | null, load: () => Promise<T>): ApiState<T> {
    const [settled, setSettled] = useState<Settled<T> | null>(null);

    useEffect(() => {
        if (key === null) return;
        let cancelled = false;
        load().then(
            data => {
                if (!cancelled) setSettled({ key, data });
            },
            (error: unknown) => {
                if (!cancelled) {
                    setSettled({
                        key,
                        error: error instanceof Error ? error : new Error(String(error))
                    });
                }
            }
        );
        return () => {
            cancelled = true;
        };
        // `load` is recreated every render; `key` captures everything it depends on.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    }, [key]);

    return {
        data: settled?.data,
        error: settled?.key === key ? settled.error : undefined,
        loading: key !== null && settled?.key !== key
    };
}
