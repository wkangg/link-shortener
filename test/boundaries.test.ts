import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The redirect hot path must stay tiny: no frameworks, no React, nothing from
// the dashboard. Only these import specifiers are allowed under src/redirect/.
const ALLOWED = [
    /^\.\/[\w.-]+\.ts$/,
    /^\.\.\/config\.ts$/,
    /^\.\.\/db\/[\w.-]+\.ts$/,
    /^\.\.\/shared\//,
    /^bun:/,
    /^node:/
];

const dir = path.join(import.meta.dir, '..', 'src', 'redirect');
const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(f =>
    f.endsWith('.ts')
);
const IMPORT_RE =
    /(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

describe('src/redirect import boundary', () => {
    test('has files to check', () => expect(files.length).toBeGreaterThan(0));

    test.each(files)('%s', file => {
        const src = readFileSync(path.join(dir, file), 'utf8');
        const bad = [...src.matchAll(IMPORT_RE)]
            .map(m => m[1] ?? m[2] ?? '')
            .filter(spec => !ALLOWED.some(re => re.test(spec)));
        expect(bad).toEqual([]);
    });
});
