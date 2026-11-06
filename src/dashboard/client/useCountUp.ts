import { useEffect, useRef, useState } from 'react';

import { animate, useReducedMotion } from './motion.ts';

/**
 * Eases a displayed number from its last value to `target` whenever `target` changes,
 * starting from 0 the first time. Jumps straight there with reduced motion on.
 */
export function useCountUp(target: number): number {
    const reduce = useReducedMotion();
    const [shown, setShown] = useState(0);
    // The value on screen, so a change mid-animation continues from there.
    const current = useRef(0);

    useEffect(() => {
        if (reduce) {
            current.current = target;
            return;
        }
        const from = current.current;
        if (from === target) {
            // Nothing to ease, but `shown` may be stale after reduced motion turns off.
            const id = requestAnimationFrame(() => setShown(target));
            return () => cancelAnimationFrame(id);
        }
        return animate(k => {
            current.current = Math.round(from + (target - from) * k);
            setShown(current.current);
        });
    }, [target, reduce]);

    return reduce ? target : shown;
}
