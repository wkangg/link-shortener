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

/** Where scroll positions outlive a reload: per tab, like the history they belong to. */
const SCROLL_STORE = 'scroll-positions';
/** How many entries' positions are saved, most recently left first. */
const SCROLL_SAVED = 200;

/** How far each history entry was scrolled when it was left, by the key in its state. */
const scrollOf = new Map<number, number>(readScrollPositions());

function readScrollPositions(): [number, number][] {
    try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(SCROLL_STORE) ?? '[]');
        return Array.isArray(saved) ? (saved as [number, number][]) : [];
    } catch {
        return [];
    }
}
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
/**
 * The entry whose page is on screen. It trails `currentKey` for the frame before a
 * transition's update runs, when the scroll position still belongs to the page being left.
 */
let renderedKey = currentKey;

/** Remembers how far the page on screen is scrolled, as its entry's most recent position. */
function rememberScroll() {
    scrollOf.delete(renderedKey);
    scrollOf.set(renderedKey, scrollY);
}

// Leaving or reloading the page saves where every entry was, the current one included.
// Hidden tabs are saved too: mobile browsers can discard them without a `pagehide`.
function saveScroll() {
    rememberScroll();
    try {
        const recent = [...scrollOf].slice(-SCROLL_SAVED);
        sessionStorage.setItem(SCROLL_STORE, JSON.stringify(recent));
    } catch {
        // Storage is off or full; positions just don't survive the reload.
    }
}
addEventListener('pagehide', saveScroll);
addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveScroll();
});

/** Stops restoring a scroll position, if one is still being restored. */
let stopRestoring = () => {};

/**
 * Scrolls to `top`. A page whose data is still loading (after a reload, or going back to one
 * with nothing kept) can be too short to get there, so this scrolls again each time the page
 * grows, until it arrives, the user scrolls or navigates, or 5 s pass.
 */
function restoreScroll(top: number) {
    stopRestoring();
    scrollTo(0, top);
    if (Math.abs(scrollY - top) < 1) return;

    const stopOn = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    const attempt = () => {
        scrollTo(0, top);
        if (Math.abs(scrollY - top) < 1) stopRestoring();
    };
    const observer = new ResizeObserver(attempt);
    const timer = setTimeout(() => stopRestoring(), 5000);
    stopRestoring = () => {
        observer.disconnect();
        clearTimeout(timer);
        for (const type of stopOn) removeEventListener(type, stopRestoring);
        stopRestoring = () => {};
    };
    for (const type of stopOn) addEventListener(type, stopRestoring, { passive: true });
    observer.observe(document.documentElement);
}

const reloadedTop = scrollOf.get(currentKey);
if (reloadedTop) restoreScroll(reloadedTop);

/** The bottom of the nav, in page coordinates. */
function navBottom(): number {
    const nav = document.querySelector('.topbar nav');
    return nav ? nav.getBoundingClientRect().bottom + scrollY : 0;
}

/**
 * Re-renders subscribers, then scrolls to `top` if given. A change of page runs inside a view
 * transition, so the old page fades out where it was as the new one rises in
 * (`::view-transition-*(page)` in styles.css). Query-only changes, like the links filter,
 * update in place. `animated`: the browser already animated it, like a back swipe in
 * Safari, so a second animation would replay the page just swiped away.
 */
function notify(top?: number, animated = false) {
    stopRestoring();
    // A transition still waiting to update has nothing left to animate: its update renders
    // where this navigation goes, and this one animates (or doesn't) itself.
    latest?.skipTransition();
    const navigation = ++navigations;
    const pageChanged = location.pathname !== renderedPath;
    const update = () => {
        renderedPath = location.pathname;
        renderedKey = currentKey;
        // Rendered now rather than on React's schedule, so there's a page to scroll.
        flushSync(() => {
            for (const listener of listeners) listener();
        });
        // A transition's update runs a frame later. If Back or another navigation came in
        // first, it rendered the current page above, but the scroll position is no longer its.
        if (top !== undefined && navigation === navigations) restoreScroll(top);
    };
    if (!pageChanged || animated || !document.startViewTransition || prefersReducedMotion()) {
        update();
        return;
    }

    const root = document.documentElement;
    const from = scrollY;
    const to = top ?? from;
    // The pill only slides when the nav is on screen before and after. Otherwise it would
    // fly in from, or off to, wherever the scroll put the nav. Set before the old snapshot.
    const bottom = navBottom();
    root.toggleAttribute('data-nav-still', from >= bottom || to >= bottom);

    const transition = document.startViewTransition(() => {
        update();
        // The page layer is drawn where the new page is; this keeps the old one where it was.
        // Measured after scrolling, which falls short of `to` while the page is loading.
        if (navigation === navigations)
            root.style.setProperty('--page-shift', `${scrollY - from}px`);
    });
    void transition.finished.finally(() => {
        // A newer transition skips this one and sets these for itself.
        if (latest !== transition) return;
        root.style.removeProperty('--page-shift');
        root.removeAttribute('data-nav-still');
    });
    latest = transition;
}

let latest: ViewTransition | undefined;
/** Counts navigations, so a late update can tell whether a newer one has started. */
let navigations = 0;

function onPopState(event: PopStateEvent) {
    rememberScroll();
    currentKey = entryKey();
    notify(scrollOf.get(currentKey) ?? 0, event.hasUAVisualTransition);
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
    rememberScroll();
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
