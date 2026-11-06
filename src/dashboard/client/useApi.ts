import { useEffect, useState } from 'react';

export interface ApiState<T> {
    data: T | undefined;
    error: Error | undefined;
    loading: boolean;
}

interface Settled<T> {
    /** null for data kept from an earlier mount, which no request key matches. */
    key: string | null;
    data?: T;
    error?: Error;
}

/** The last data loaded under each `keep` name, for as long as the page is open. */
const kept = new Map<string, unknown>();

/**
 * Fetches whenever `key` changes. The previous data stays visible while the
 * next request is in flight, so filters don't flash the page empty.
 *
 * With `keep`, that previous data also outlives the component: mounting again under the
 * same name starts from what it last showed and refreshes from there. A page you go back
 * to is then whole as it animates in, instead of filling in while it moves.
 */
export function useApi<T>(key: string | null, load: () => Promise<T>, keep?: string): ApiState<T> {
    const [settled, setSettled] = useState<Settled<T> | null>(() =>
        keep !== undefined && kept.has(keep) ? { key: null, data: kept.get(keep) as T } : null
    );

    useEffect(() => {
        if (key === null) return;
        let cancelled = false;
        load().then(
            data => {
                if (keep !== undefined) kept.set(keep, data);
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
