import { useSyncExternalStore } from 'react';

/** How long numbers and the chart take to ease to new data. */
export const DURATION_MS = 600;

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

// Called lazily so importing this module without a DOM (tests) doesn't throw.
const reducedMotionQuery = () => matchMedia('(prefers-reduced-motion: reduce)');

function subscribeToReducedMotion(onChange: () => void): () => void {
    const query = reducedMotionQuery();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

/** Whether the user asked for reduced motion, updating if they change it. */
export function useReducedMotion(): boolean {
    return useSyncExternalStore(subscribeToReducedMotion, () => reducedMotionQuery().matches);
}

/**
 * Calls `frame` with eased progress from 0 to 1 over DURATION_MS, starting on the next
 * animation frame. Returns a function that cancels it.
 */
export function animate(frame: (progress: number) => void): () => void {
    let id = 0;
    let start: number | undefined;
    const step = (now: number) => {
        start ??= now;
        const t = Math.min(1, (now - start) / DURATION_MS);
        frame(easeOutCubic(t));
        if (t < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
}
