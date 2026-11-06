import { type MouseEvent, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

import { prefersReducedMotion } from './motion.ts';

const listeners = new Set<() => void>();

/** The pathname the page last rendered, to tell a page change from a query change. */
let renderedPath = location.pathname;

// Back and forward restore their scroll position here rather than in the browser, which
// does it as soon as `popstate` fires: against the page being left, before a transition
// renders the one it belongs to.
history.scrollRestoration = 'manual';
/** How far each history entry was scrolled when it was left, by the key in its state. */
const scrollOf = new Map<number, number>();
// Started from the clock so entries from before a reload, which keep their keys, don't clash.
let nextKey = Date.now();

/** The current history entry's key, giving it one if it has none (the first page loaded). */
function entryKey(): number {
    const key: unknown = (history.state as { key?: unknown } | null)?.key;
    if (typeof key === 'number') return key;
    const fresh = nextKey++;
    history.replaceState({ key: fresh }, '');
    return fresh;
}

let currentKey = entryKey();

/** The bottom of the nav, in page coordinates. */
function navBottom(): number {
    const nav = document.querySelector('.topbar nav');
    return nav ? nav.getBoundingClientRect().bottom + scrollY : 0;
}

/**
 * Re-renders subscribers, then scrolls to `top` if given. A change of page runs inside a view
 * transition, so the old page fades out where it was as the new one rises in
 * (`::view-transition-*(page)` in styles.css). Query-only changes, like the links filter,
 * update in place.
 */
function notify(top?: number) {
    const pageChanged = location.pathname !== renderedPath;
    const update = () => {
        renderedPath = location.pathname;
        // Rendered now rather than on React's schedule, so there's a page to scroll.
        flushSync(() => {
            for (const listener of listeners) listener();
        });
        if (top !== undefined) scrollTo(0, top);
    };
    if (!pageChanged || !document.startViewTransition || prefersReducedMotion()) {
        update();
        return;
    }

    const root = document.documentElement;
    const from = scrollY;
    const to = top ?? from;
    // The page layer is drawn where the new page is; this keeps the old one where it was.
    root.style.setProperty('--page-shift', `${to - from}px`);
    // The pill only slides when the nav is on screen before and after. Otherwise it would
    // fly in from, or off to, wherever the scroll put the nav.
    const bottom = navBottom();
    root.toggleAttribute('data-nav-still', from >= bottom || to >= bottom);

    const transition = document.startViewTransition(update);
    void transition.finished.finally(() => {
        // A newer transition skips this one and sets these for itself.
        if (latest !== transition) return;
        root.style.removeProperty('--page-shift');
        root.removeAttribute('data-nav-still');
    });
    latest = transition;
}

let latest: ViewTransition | undefined;

function onPopState() {
    scrollOf.set(currentKey, scrollY);
    currentKey = entryKey();
    notify(scrollOf.get(currentKey) ?? 0);
}

function subscribe(listener: () => void) {
    if (listeners.size === 0) globalThis.addEventListener('popstate', onPopState);
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) globalThis.removeEventListener('popstate', onPopState);
    };
}

const snapshot = () => location.pathname + location.search;

/** Opens `to`, starting at the top; `replace` swaps the current entry and keeps the scroll. */
export function navigate(to: string, replace = false) {
    if (replace) {
        history.replaceState({ key: currentKey }, '', to);
        notify();
        return;
    }
    scrollOf.set(currentKey, scrollY);
    currentKey = nextKey++;
    history.pushState({ key: currentKey }, '', to);
    notify(0);
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
