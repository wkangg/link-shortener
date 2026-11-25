import { useSyncExternalStore } from 'react';

/** How long numbers and the chart take to ease to new data. */
const DURATION_MS = 600;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

// Called lazily so importing this module without a DOM (tests) doesn't throw.
const reducedMotionQuery = () => matchMedia('(prefers-reduced-motion: reduce)');

/** Whether the user asked for reduced motion, for code outside React. */
export const prefersReducedMotion = () => reducedMotionQuery().matches;

function subscribeToReducedMotion(onChange: () => void): () => void {
    const query = reducedMotionQuery();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

/** Whether the user asked for reduced motion, updating if they change it. */
export function useReducedMotion(): boolean {
    return useSyncExternalStore(subscribeToReducedMotion, prefersReducedMotion);
}

/** How many `animate` calls are running, for work that waits until nothing moves. */
let running = 0;
const runningListeners = new Set<() => void>();

function setRunning(delta: number) {
    running += delta;
    for (const listener of runningListeners) listener();
}

function subscribeToRunning(onChange: () => void): () => void {
    runningListeners.add(onChange);
    return () => runningListeners.delete(onChange);
}

/** Whether any numbers or the chart are still easing. */
export function useAnimating(): boolean {
    return useSyncExternalStore(subscribeToRunning, () => running > 0);
}

/**
 * Calls `frame` with eased progress from 0 to 1 over DURATION_MS, starting on the next
 * animation frame. Returns a function that cancels it.
 */
export function animate(frame: (progress: number) => void): () => void {
    let id = 0;
    let start: number | undefined;
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        setRunning(-1);
    };
    const step = (now: number) => {
        start ??= now;
        const t = Math.min(1, (now - start) / DURATION_MS);
        frame(easeOutCubic(t));
        if (t < 1) id = requestAnimationFrame(step);
        else finish();
    };
    setRunning(1);
    id = requestAnimationFrame(step);
    return () => {
        cancelAnimationFrame(id);
        finish();
    };
}
