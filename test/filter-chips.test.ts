import { describe, expect, test } from 'bun:test';

import { mergeChips, type ShownChip } from '../src/dashboard/client/components/FilterChips.tsx';
import { searchChips, toggleTerm } from '../src/dashboard/client/components/SearchBox.tsx';

const labels = (search: string) => searchChips(search).map(c => c.label);
const shown = (search: string): ShownChip[] =>
    searchChips(search).map(c => ({ ...c, leaving: false }));

describe('searchChips', () => {
    test('a chip per top-level term, each removing only itself', () => {
        const chips = searchChips('link:=/ source:=Direct country:=CA');
        expect(chips.map(c => c.label)).toEqual(['link:=/', 'source:=Direct', 'country:=CA']);
        expect(chips.map(c => c.rest)).toEqual([
            'source:=Direct country:=CA',
            'link:=/ country:=CA',
            'link:=/ source:=Direct'
        ]);
    });

    test('nothing for an empty search', () => {
        expect(searchChips('')).toEqual([]);
        expect(searchChips('   ')).toEqual([]);
    });

    test('quoted values and bracketed groups stay whole', () => {
        expect(labels('os:="Mac OS" (is:bot || is:dc) -(country:=CA country:=US)')).toEqual([
            'os:="Mac OS"',
            '(is:bot || is:dc)',
            '-(country:=CA country:=US)'
        ]);
        expect(labels('ua:"a || b && c" is:qr')).toEqual(['ua:"a || b && c"', 'is:qr']);
    });

    test('a search joined by || or && at the top level is one chip that clears it', () => {
        for (const search of ['is:bot || is:dc', 'country:=CA && os:iOS', 'a b || c']) {
            expect(searchChips(search)).toEqual([{ key: search, label: search, rest: '' }]);
        }
    });

    test('a group added after an OR-ed search is its own chip', () => {
        // How a panel click adds to `is:bot || is:dc` (see withTerm).
        expect(labels(toggleTerm('is:bot || is:dc', 'country:=CA'))).toEqual([
            '(is:bot || is:dc)',
            'country:=CA'
        ]);
    });

    test('a repeated term gets its own key, and removing one keeps the other', () => {
        const chips = searchChips('is:qr country:=CA is:qr');
        expect(chips.map(c => c.key)).toEqual(['is:qr', 'country:=CA', 'is:qr#2']);
        expect(chips[2]?.rest).toBe('is:qr country:=CA');
    });

    test('whitespace between terms is tidied in what is left', () => {
        expect(searchChips('  a   b  ')[0]?.rest).toBe('b');
    });
});

describe('mergeChips', () => {
    test('new chips are added, removed ones stay in place while they leave', () => {
        const before = shown('a b c');
        const after = mergeChips(before, searchChips('a c d'));
        expect(after.map(c => [c.label, c.leaving])).toEqual([
            ['a', false],
            ['b', true],
            ['c', false],
            ['d', false]
        ]);
    });

    test('a chip that comes back while leaving is kept', () => {
        const leaving = mergeChips(shown('a b'), searchChips('a'));
        const back = mergeChips(leaving, searchChips('a b'));
        expect(back.map(c => [c.key, c.leaving])).toEqual([
            ['a', false],
            ['b', false]
        ]);
    });

    test('a term edited in place keeps its chip', () => {
        const before = shown('a country:=C');
        const after = mergeChips(before, searchChips('a country:=CA'));
        expect(after.map(c => [c.key, c.label, c.leaving])).toEqual([
            ['a', 'a', false],
            ['country:=C', 'country:=CA', false]
        ]);
        // And keeps it as the edit goes on.
        const later = mergeChips(after, searchChips('a country:=CAN'));
        expect(later.map(c => c.key)).toEqual(['a', 'country:=C']);
    });

    test('the chips left after a removal carry the search without it', () => {
        const after = mergeChips(shown('a b c'), searchChips('a c'));
        expect(after.find(c => c.key === 'c')?.rest).toBe('a');
    });

    test('splitting an OR-ed search replaces its chip', () => {
        const after = mergeChips(shown('a || b'), searchChips('a b'));
        expect(after.map(c => [c.label, c.leaving])).toEqual([
            ['a', false],
            ['b', false]
        ]);
    });
});
