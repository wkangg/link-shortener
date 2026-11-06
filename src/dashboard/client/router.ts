import { type MouseEvent, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

import { prefersReducedMotion } from './motion.ts';

const listeners = new Set<() => void>();

/** The pathname the page last rendered, to tell a page change from a query change. */
let renderedPath = location.pathname;

/**
 * Re-renders subscribers. A new page opened from a link (`pushed`) starts at the top, and
 * runs in a view transition, so the old page fades out as the new one rises in
 * (`::view-transition-*(page)` in styles.css). Query-only changes, like the links filter,
 * update in place.
 *
 * Back and forward switch instantly: the browser restores their scroll position right after
 * `popstate`, which only works if the page it belongs to renders before a transition would.
 */
function notify(pushed: boolean) {
    const pageChanged = location.pathname !== renderedPath;
    const update = () => {
        renderedPath = location.pathname;
        for (const listener of listeners) listener();
    };
    // Before the old page's snapshot, so the snapshots line up and only the pill moves sideways.
    if (pushed && pageChanged) scrollTo(0, 0);
    if (!pushed || !pageChanged || !document.startViewTransition || prefersReducedMotion()) {
        update();
        return;
    }
    // The new page has to be in the DOM when the callback returns, for its snapshot.
    document.startViewTransition(() => flushSync(update));
}

const onPopState = () => notify(false);

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
    notify(true);
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
