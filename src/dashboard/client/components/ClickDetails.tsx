import type { ReactNode } from 'react';

import type { ClickHistoryRow, TraitRecord } from '../../../shared/types.ts';

/** Known layouts by their top letter row; anything else shows its first keys. */
function layoutName(keys: string): string {
    const row = keys.slice(0, 6).toLowerCase();
    if (row === 'qwerty') return 'QWERTY';
    if (row === 'qwertz') return 'QWERTZ';
    if (row === 'azerty') return 'AZERTY';
    if (row.startsWith("',.py")) return 'Dvorak';
    if (row === 'qwfpgj' || row === 'qwfpbj') return 'Colemak';
    return `other (${keys.slice(0, 10)}…)`;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "fr-FR · gregory calendar · latn digits · 24-hour". */
function regional(intl: TraitRecord): string {
    const hour = intl.hourCycle;
    return [
        intl.locale,
        intl.calendar && `${String(intl.calendar)} calendar`,
        intl.numbering && `${String(intl.numbering)} digits`,
        hour && (hour === 'h23' || hour === 'h24' ? '24-hour' : '12-hour')
    ]
        .filter(Boolean)
        .join(' · ');
}

const GAMUTS: Record<string, string> = { srgb: 'sRGB', p3: 'P3', rec2020: 'Rec. 2020' };

/** "P3 color · HDR · fine pointer · hover". */
function mediaFeatures(f: TraitRecord): string {
    const gamut = typeof f.gamut === 'string' ? (GAMUTS[f.gamut] ?? f.gamut) : null;
    return [
        gamut && `${gamut} color`,
        f.hdr ? 'HDR' : null,
        f.pointer && `${String(f.pointer)} pointer`,
        f.anyPointer && f.anyPointer !== f.pointer ? `also ${String(f.anyPointer)}` : null,
        f.hover ? 'hover' : f.hover === false ? 'no hover' : null,
        f.monochrome ? 'monochrome' : null
    ]
        .filter(Boolean)
        .join(' · ');
}

function devices(d: TraitRecord): string {
    const n = (key: string) => (typeof d[key] === 'number' ? d[key] : 0);
    return [
        plural(n('cameras'), 'camera'),
        plural(n('microphones'), 'microphone'),
        plural(n('speakers'), 'speaker')
    ].join(' · ');
}

/** "key: value" for every entry; lists show their length. */
function entries(r: TraitRecord, skip: string[] = []): string[] {
    return Object.entries(r)
        .filter(([key]) => !skip.includes(key))
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.length : String(value)}`);
}

/** A long list, collapsed under its count. */
function Collapsed({ label, items }: { label: string; items: string[] }) {
    return (
        <details className="history-raw">
            <summary>
                {label} ({items.length})
            </summary>
            <ul className="trait-items">
                {items.map(item => (
                    <li key={item}>{item}</li>
                ))}
            </ul>
        </details>
    );
}

/**
 * Everything else the browser reported, collapsed under "More details": regional
 * formats, keyboard, WebGL, voices, permissions and the like.
 */
export function ClickDetails({ c }: { c: ClickHistoryRow }) {
    const rows: [string, ReactNode][] = [];
    const add = (label: string, value: ReactNode) => {
        if (value !== null && value !== undefined && value !== '') rows.push([label, value]);
    };

    add('Window', c.viewport?.replace('x', '×'));
    if (c.multiMonitor !== null) add('Monitors', c.multiMonitor ? 'more than one' : 'one');
    add('Display', c.mediaFeatures && mediaFeatures(c.mediaFeatures));
    add('Languages', c.languages?.join(', '));
    add('Regional', c.intl && regional(c.intl));
    if (c.intl?.date || c.intl?.number) {
        add('Formats', [c.intl.date, c.intl.number].filter(Boolean).join(' · '));
    }
    add(
        'Keyboard',
        c.keyboard && (
            <span title={c.keyboard} className="mono">
                {layoutName(c.keyboard)}
            </span>
        )
    );
    if (c.emoji !== null) add('Emoji', c.emoji > 0 ? `up to Emoji ${c.emoji}` : 'no color emoji');
    add('Devices', c.mediaDevices && devices(c.mediaDevices));
    add('Permissions', c.permissions && entries(c.permissions).join(' · '));
    add(
        'WebGPU',
        c.webgpu &&
            [c.webgpu.vendor, c.webgpu.architecture, c.webgpu.device, c.webgpu.description]
                .filter(Boolean)
                .join(' · ')
    );
    if (c.webgl) {
        const extensions = Array.isArray(c.webgl.extensions) ? c.webgl.extensions : [];
        add(
            'WebGL',
            <>
                <Collapsed label="Parameters" items={entries(c.webgl, ['extensions'])} />
                {extensions.length > 0 && <Collapsed label="Extensions" items={extensions} />}
            </>
        );
    }
    add('Voices', c.voices && <Collapsed label="Voices" items={c.voices} />);
    add('Canvas', c.canvas && <span className="mono">{c.canvas}</span>);
    add('Audio', c.audio && <span className="mono">{c.audio}</span>);
    add('Math', c.math && <span className="mono">{c.math}</span>);

    if (rows.length === 0) return null;
    return (
        <details className="history-raw">
            <summary>More details</summary>
            <dl className="trait-list">
                {rows.map(([label, value]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
        </details>
    );
}
