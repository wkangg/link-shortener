import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

const DURATION_MS = 600;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

// Called lazily so importing this module without a DOM (tests) doesn't throw.
const reducedMotionQuery = () => matchMedia('(prefers-reduced-motion: reduce)');

function subscribeToReducedMotion(onChange: () => void): () => void {
    const query = reducedMotionQuery();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

export function useReducedMotion(): boolean {
    return useSyncExternalStore(subscribeToReducedMotion, () => reducedMotionQuery().matches);
}

/**
 * Eases a displayed number from its last value to `target` whenever `target` changes,
 * starting from 0 the first time. Jumps straight there with reduced motion on.
 */
export function useCountUp(target: number | undefined): number | undefined {
    const reduce = useReducedMotion();
    const [shown, setShown] = useState(0);
    // The value on screen, so a change mid-animation continues from there.
    const current = useRef(0);

    useEffect(() => {
        if (target === undefined) return;
        if (reduce) {
            current.current = target;
            return;
        }
        const from = current.current;
        let frame = 0;
        let start: number | undefined;
        const step = (now: number) => {
            start ??= now;
            // Unchanged (e.g. after reduced motion turns off) syncs in a single frame.
            const t = from === target ? 1 : Math.min(1, (now - start) / DURATION_MS);
            current.current = Math.round(from + (target - from) * easeOutCubic(t));
            setShown(current.current);
            if (t < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
        return () => cancelAnimationFrame(frame);
    }, [target, reduce]);

    if (target === undefined || reduce) return target;
    return shown;
}
