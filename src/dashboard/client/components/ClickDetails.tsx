import type { ReactNode } from 'react';

import type { ClickHistoryRow, TraitRecord } from '../../../shared/types.ts';
import { gpuName, screenLabel } from '../format.ts';

/** Known layouts by their top letter row; anything else shows its first keys. */
function layoutName(keys: string): string {
    const row = keys.slice(0, 6).toLowerCase();
    if (row === 'qwerty') return 'QWERTY';
    if (row === 'qwertz') return 'QWERTZ';
    if (row === 'azerty') return 'AZERTY';
    if (row.startsWith("',.py")) return 'Dvorak';
    if (row === 'qwfpgj' || row === 'qwfpbj') return 'Colemak';
    return `Other (${keys.slice(0, 10)}…)`;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function text(value: unknown): string | null {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

const GAMUTS: Record<string, string> = { srgb: 'sRGB', p3: 'Display P3', rec2020: 'Rec. 2020' };

/** "1440×852 · 24-bit" from "1440x852x24". */
function usable(display: string): string {
    const [w, h, depth] = display.split('x');
    return `${w}×${h} · ${depth}-bit`;
}

/** Non-default permissions, or a note that everything is at its default. */
function permissions(p: TraitRecord): string {
    const changed = Object.entries(p).filter(([, state]) => state !== 'prompt');
    if (changed.length === 0) return 'all at default (ask)';
    return changed.map(([name, state]) => `${name} ${String(state)}`).join(', ');
}

function mono(value: string | null) {
    return value && <span className="mono">{value}</span>;
}

/** Browser settings plus the color scheme, e.g. "dark mode, cookies on, PDF viewer". */
function settings(c: ClickHistoryRow): string | null {
    const scheme = c.darkMode === null ? [] : [c.darkMode ? 'dark mode' : 'light mode'];
    const all = [...scheme, ...(c.settings ?? [])];
    return all.length > 0 ? all.join(', ') : null;
}

type Row = [label: string, value: ReactNode];

/** A titled group of label / value rows; hidden when every value is missing. */
function Section({ title, rows }: { title: string; rows: Row[] }) {
    const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
    if (shown.length === 0) return null;
    return (
        <section className="click-details-section">
            <h4>{title}</h4>
            <dl>
                {shown.map(([label, value]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}

/** A long list as chips, collapsed under its name and count. */
function Chips({ label, items }: { label: string; items: string[] | null | undefined }) {
    if (!items || items.length === 0) return null;
    return (
        <details className="click-details-list">
            <summary>
                {label} <span className="muted">{items.length}</span>
            </summary>
            <div className="click-details-chips">
                {items.map(item => (
                    <span key={item} className="chip">
                        {item}
                    </span>
                ))}
            </div>
        </details>
    );
}

/** Whether the browser reported anything worth a details panel. */
export function hasDetails(c: ClickHistoryRow): boolean {
    return [
        c.screen,
        c.gpu,
        c.battery,
        c.connection,
        c.settings,
        c.darkMode,
        c.display,
        c.viewport,
        c.intl,
        c.languages,
        c.keyboard,
        c.webgl,
        c.webgpu,
        c.mediaDevices,
        c.permissions,
        c.fonts,
        c.codecs,
        c.voices,
        c.canvas,
        c.audio,
        c.math
    ].some(v => v !== null);
}

/** Everything the browser reported beyond the summary columns, grouped, under its click. */
export function ClickDetails({ c }: { c: ClickHistoryRow }) {
    const f = c.mediaFeatures;
    const intl = c.intl;
    const webgl = c.webgl;
    const devices = c.mediaDevices;
    const count = (key: string) => (typeof devices?.[key] === 'number' ? devices[key] : 0);
    const gamut = typeof f?.gamut === 'string' ? (GAMUTS[f.gamut] ?? f.gamut) : null;

    return (
        <div className="click-details">
            <div className="click-details-grid">
                <Section
                    title="Display"
                    rows={[
                        ['Screen', c.screen && screenLabel(c.screen)],
                        ['Usable', c.display && usable(c.display)],
                        ['Window', c.viewport?.replace('x', '×')],
                        ['Orientation', c.orientation?.split('-')[0]],
                        [
                            'Monitors',
                            c.multiMonitor === null ? null : c.multiMonitor ? 'several' : 'one'
                        ],
                        ['Color', gamut && `${gamut}${f?.hdr ? ' · HDR' : ''}`],
                        [
                            'Input',
                            f &&
                                [
                                    text(f.pointer) && `${text(f.pointer)} pointer`,
                                    f.hover ? 'hover' : null
                                ]
                                    .filter(Boolean)
                                    .join(' · ')
                        ]
                    ]}
                />
                <Section
                    title="Language & region"
                    rows={[
                        ['Languages', c.languages?.join(', ')],
                        ['Locale', text(intl?.locale)],
                        ['Timezone', c.timezone],
                        [
                            'Clock',
                            text(intl?.hourCycle) &&
                                (intl?.hourCycle === 'h23' || intl?.hourCycle === 'h24'
                                    ? '24-hour'
                                    : '12-hour')
                        ],
                        ['Calendar', text(intl?.calendar)],
                        ['Date', text(intl?.date)],
                        ['Number', text(intl?.number)],
                        [
                            'Keyboard',
                            c.keyboard && <span title={c.keyboard}>{layoutName(c.keyboard)}</span>
                        ]
                    ]}
                />
                <Section
                    title="Hardware"
                    rows={[
                        ['GPU', c.gpu && <span title={c.gpu}>{gpuName(c.gpu)}</span>],
                        ['Memory', c.memory === null ? null : `${c.memory} GB`],
                        ['CPU', c.cpuCores === null ? null : plural(c.cpuCores, 'core')],
                        [
                            'Touch',
                            c.touchPoints === null
                                ? null
                                : c.touchPoints > 0
                                  ? `${plural(c.touchPoints, 'point')}`
                                  : 'none'
                        ],
                        [
                            'Battery',
                            c.battery === null
                                ? null
                                : `${c.battery}%${c.charging ? ' · charging' : ''}`
                        ],
                        ['Network', c.connection],
                        [
                            'WebGPU',
                            c.webgpu &&
                                [c.webgpu.vendor, c.webgpu.architecture, c.webgpu.description]
                                    .filter(Boolean)
                                    .join(' · ')
                        ],
                        [
                            'WebGL',
                            webgl && [webgl.version, webgl.vendor].filter(Boolean).join(' · ')
                        ],
                        [
                            'Media',
                            devices &&
                                [
                                    plural(count('cameras'), 'camera'),
                                    plural(count('microphones'), 'mic'),
                                    plural(count('speakers'), 'speaker')
                                ].join(' · ')
                        ],
                        [
                            'Emoji',
                            c.emoji === null
                                ? null
                                : c.emoji > 0
                                  ? `up to Emoji ${c.emoji}`
                                  : 'no color emoji'
                        ]
                    ]}
                />
                <Section
                    title="Privacy & hashes"
                    rows={[
                        ['Settings', settings(c)],
                        ['Private', c.incognito === null ? null : c.incognito ? 'yes' : 'no'],
                        ['Ad blocker', c.adBlocker === null ? null : c.adBlocker ? 'yes' : 'no'],
                        ['Permissions', c.permissions && permissions(c.permissions)],
                        ['Fingerprint', mono(c.fingerprint)],
                        ['Canvas', mono(c.canvas)],
                        ['Audio', mono(c.audio)],
                        ['Math', mono(c.math)]
                    ]}
                />
            </div>
            <div className="click-details-lists">
                <Chips label="Fonts" items={c.fonts} />
                <Chips label="Codecs" items={c.codecs} />
                <Chips label="Voices" items={c.voices} />
                <Chips
                    label="WebGL extensions"
                    items={Array.isArray(webgl?.extensions) ? webgl.extensions : null}
                />
                <Chips
                    label="WebGL limits"
                    items={
                        webgl &&
                        Object.entries(webgl)
                            .filter(([key]) => !['extensions', 'version', 'vendor'].includes(key))
                            .map(([key, value]) => `${key} ${String(value)}`)
                    }
                />
            </div>
        </div>
    );
}
