import { type MouseEvent, useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
    listeners.add(listener);
    globalThis.addEventListener('popstate', listener);
    return () => {
        listeners.delete(listener);
        globalThis.removeEventListener('popstate', listener);
    };
}

const snapshot = () => location.pathname + location.search;

export function navigate(to: string, replace = false) {
    if (replace) history.replaceState(null, '', to);
    else history.pushState(null, '', to);
    for (const listener of listeners) listener();
}

/** Current path + query, re-rendering on navigation. */
export function useLocation(): { path: string; search: URLSearchParams } {
    const current = useSyncExternalStore(subscribe, snapshot);
    const q = current.indexOf('?');
    return {
        path: q === -1 ? current : current.slice(0, q),
        search: new URLSearchParams(q === -1 ? '' : current.slice(q))
    };
}

/** onClick for <a href> that navigates client-side (keeps cmd/ctrl-click working). */
export function linkClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
    }
    event.preventDefault();
    navigate(event.currentTarget.getAttribute('href') ?? '/');
}
