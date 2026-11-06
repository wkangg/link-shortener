import { useEffect, useRef, useState } from 'react';

import { useReducedMotion } from '../motion.ts';
import { type SearchChip, searchChips } from './SearchBox.tsx';

/** How long a removed chip takes to leave; matches `.chip-leaving` in styles.css. */
const LEAVE_MS = 220;

/** A chip on screen: one of the search's, or one that's animating out. */
export interface ShownChip extends SearchChip {
    leaving: boolean;
}

/**
 * The chips to show for `next` after `shown`. Chips no longer in the search stay where
 * they were, leaving. A new chip where one has just gone (a term edited in the search
 * box) takes over that chip's key, so it changes in place rather than leaving and
 * coming back for every keystroke.
 */
export function mergeChips(shown: ShownChip[], next: SearchChip[]): ShownChip[] {
    const nextKeys = new Set(next.map(c => c.key));
    const shownKeys = new Set(shown.map(c => c.key));
    const staying = shown.filter(c => !c.leaving);
    const merged: ShownChip[] = next.map((chip, i) => {
        const before = staying[i];
        const edited = !shownKeys.has(chip.key) && before && !nextKeys.has(before.key);
        return { ...chip, key: edited ? before.key : chip.key, leaving: false };
    });
    const kept = new Set(merged.map(c => c.key));
    for (const [i, chip] of shown.entries()) {
        if (!kept.has(chip.key))
            merged.splice(Math.min(i, merged.length), 0, { ...chip, leaving: true });
    }
    return merged;
}

interface FilterChipsProps {
    /** The search applied to the page. */
    search: string;
    /** Applies the search left after a chip is removed. */
    onChange: (search: string) => void;
}

/** A chip per filter in the search (see `searchChips`), each removing just its filter. */
export function FilterChips({ search, onChange }: FilterChipsProps) {
    const reduce = useReducedMotion();
    const [shown, setShown] = useState<ShownChip[]>(() => mergeChips([], searchChips(search)));
    const [shownFor, setShownFor] = useState(search);
    if (search !== shownFor) {
        setShownFor(search);
        const next = mergeChips(shown, searchChips(search));
        // With reduced motion there's no exit animation to wait for.
        setShown(reduce ? next.filter(c => !c.leaving) : next);
    }

    useEffect(() => {
        if (!shown.some(c => c.leaving)) return;
        const timer = setTimeout(() => setShown(s => s.filter(c => !c.leaving)), LEAVE_MS);
        return () => clearTimeout(timer);
    }, [shown]);

    // So removing a chip with the keyboard moves focus to its neighbour, not the page.
    const buttons = useRef(new Map<string, HTMLButtonElement>());
    const remove = (chip: ShownChip, button: HTMLButtonElement) => {
        const staying = shown.filter(c => !c.leaving);
        const i = staying.findIndex(c => c.key === chip.key);
        const neighbour = staying[i + 1] ?? staying[i - 1];
        onChange(chip.rest);
        if (document.activeElement === button && neighbour)
            buttons.current.get(neighbour.key)?.focus();
    };

    return (
        <ul className="chips" aria-label="Active filters">
            {shown.map(chip => (
                <li
                    key={chip.key}
                    className={chip.leaving ? 'chip-item chip-leaving' : 'chip-item'}
                    inert={chip.leaving}
                >
                    <button
                        ref={el => {
                            if (el) buttons.current.set(chip.key, el);
                            return () => {
                                buttons.current.delete(chip.key);
                            };
                        }}
                        type="button"
                        className="chip mono"
                        aria-label={`Remove filter ${chip.label}`}
                        onClick={e => remove(chip, e.currentTarget)}
                    >
                        {chip.label}
                        <span aria-hidden="true">×</span>
                    </button>
                </li>
            ))}
        </ul>
    );
}
