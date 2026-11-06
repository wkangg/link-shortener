import { type MouseEvent, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

import { prefersReducedMotion } from './motion.ts';

const listeners = new Set<() => void>();

/** The pathname the page last rendered, to tell a page change from a query change. */
let renderedPath = location.pathname;

/**
 * Re-renders subscribers. A change of page runs inside a view transition, so the old page
 * fades out as the new one rises in (`::view-transition-*(page)` in styles.css). Query-only
 * changes, like the links filter, update in place.
 *
 * `pushed`: a new page opened from a link starts at the top; back and forward leave the
 * browser's scroll restoration alone. `animated`: the browser already animated it, like a
 * back swipe in Safari, so a second animation would play over it.
 */
function notify({ pushed = false, animated = false } = {}) {
    const pageChanged = location.pathname !== renderedPath;
    const update = () => {
        renderedPath = location.pathname;
        if (pushed && pageChanged) scrollTo(0, 0);
        for (const listener of listeners) listener();
    };
    if (!pageChanged || animated || !document.startViewTransition || prefersReducedMotion()) {
        update();
        return;
    }
    // The new page has to be in the DOM when the callback returns, for its snapshot.
    document.startViewTransition(() => flushSync(update));
}

const onPopState = (event: PopStateEvent) => notify({ animated: event.hasUAVisualTransition });

function subscribe(listener: () => void) {
    if (listeners.size === 0) globalThis.addEventListener('popstate', onPopState);
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) globalThis.removeEventListener('popstate', onPopState);
    };
}

const snapshot = () => location.pathname + location.search;

export function navigate(to: string, replace = false) {
    if (replace) history.replaceState(null, '', to);
    else history.pushState(null, '', to);
    notify({ pushed: true });
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
