import type { ReactNode } from 'react';

import type { ClickHistoryRow, TraitRecord } from '../../../shared/types.ts';
import { formatBytes, gpuName, screenLabel } from '../format.ts';

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

const BACKENDS: Record<string, string> = {
    D3D9: 'Direct3D 9',
    D3D11: 'Direct3D 11',
    D3D11on12: 'Direct3D 11 on 12',
    D3D12: 'Direct3D 12',
    OpenGL: 'OpenGL',
    'OpenGL ES': 'OpenGL ES',
    Metal: 'Metal',
    Vulkan: 'Vulkan'
};

/**
 * The parts of a WebGL renderer string. ANGLE (Chromium, recent Firefox and Safari) reports
 * "ANGLE (vendor, renderer (device id) Direct3D11 vs_5_0 ps_5_0, D3D11)"; anything else is
 * just a name. The WebGL vendor ("Google Inc. (Intel)") fills in a missing vendor.
 */
function gpuParts(renderer: string, webglVendor: string | null) {
    const angle = /^ANGLE \((.*)\)$/.exec(renderer)?.[1]?.split(', ');
    const backend = angle?.at(-1);
    const shader = /\bps_(\d+)_(\d+)\b/.exec(renderer);
    const vendor = angle?.[0] ?? /\(([^)]+)\)$/.exec(webglVendor ?? '')?.[1] ?? webglVendor;
    return {
        name: gpuName(renderer),
        vendor,
        backend: backend && angle && angle.length > 2 ? (BACKENDS[backend] ?? backend) : null,
        shaderModel: shader ? `${shader[1]}.${shader[2]}` : null,
        deviceId: /\((0x[\da-f]+)\)/i.exec(renderer)?.[1] ?? null
    };
}

/** "23-bit mantissa · ±2^127" from WebGL's high float precision "23,127,127". */
function precision(value: unknown): string | null {
    const [bits, min, max] = typeof value === 'string' ? value.split(',') : [];
    if (!bits || !max) return null;
    return `${bits}-bit mantissa · ±2^${Math.max(Number(min), Number(max))}`;
}

/** "GMT-05:00" for a zone at a moment; null for an unknown zone. */
function utcOffset(zone: string, ts: number): string | null {
    try {
        return (
            new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
                .formatToParts(ts)
                .find(part => part.type === 'timeZoneName')?.value ?? null
        );
    } catch {
        return null;
    }
}

/** "420 ms", "3.2 s", "4 min", "2 h". */
function duration(ms: number): string {
    const abs = Math.abs(ms);
    if (abs < 1000) return `${Math.round(abs)} ms`;
    if (abs < 60_000) return `${(abs / 1000).toFixed(1)} s`;
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min`;
    return `${(abs / 3_600_000).toFixed(1)} h`;
}

/** Clocks within this of the server count as in sync (it includes network delay). */
const CLOCK_TOLERANCE_MS = 120_000;

/** Coarse OS family, so "Windows" (user agent) and "Windows 11" (client hints) compare equal. */
function osFamily(os: string | null): string | null {
    const s = os?.toLowerCase() ?? '';
    if (s.startsWith('windows')) return 'windows';
    if (s.startsWith('mac')) return 'macos';
    if (s.startsWith('android')) return 'android';
    if (s.startsWith('ios') || s.startsWith('ipados')) return 'ios';
    if (s.startsWith('chrome')) return 'chromeos';
    if (s.startsWith('linux')) return 'linux';
    return null;
}

/** navigator.platform's OS family; Linux also covers Android and ChromeOS. */
function navPlatformFamily(platform: string | null): string | null {
    if (!platform) return null;
    if (platform.startsWith('Win')) return 'windows';
    if (platform.startsWith('Mac')) return 'macos';
    if (/^(iPhone|iPad|iPod)/.test(platform)) return 'ios';
    if (/^(Linux|Android)/i.test(platform)) return 'linux';
    return null;
}

const CHROMIUM = /^(Chrome|Chromium|Microsoft Edge|Opera|Brave|Vivaldi|Samsung Internet|Yandex)/;

/** navigator.vendor each engine reports; null when the browser isn't one we know. */
function expectedVendor(browser: string | null): string | null {
    if (!browser) return null;
    if (browser.startsWith('Firefox')) return '';
    if (browser === 'Safari') return 'Apple Computer, Inc.';
    if (CHROMIUM.test(browser)) return 'Google Inc.';
    return null;
}

/** In-app browsers by their user-agent marker. */
const IN_APP: [RegExp, string][] = [
    [/FBAN|FBAV|FB_IAB/, 'Facebook'],
    [/Instagram/, 'Instagram'],
    [/musical_ly|BytedanceWebview|TikTok/i, 'TikTok'],
    [/Snapchat/, 'Snapchat'],
    [/LinkedInApp/, 'LinkedIn'],
    [/Pinterest/, 'Pinterest'],
    [/MicroMessenger/, 'WeChat'],
    [/\bLine\//, 'LINE'],
    [/Twitter/, 'X (Twitter)'],
    [/Discord/, 'Discord'],
    [/Telegram/, 'Telegram'],
    [/\bGSA\//, 'Google app'],
    [/; wv\)/, 'an Android app (WebView)']
];

function inAppBrowser(ua: string | null): string | null {
    if (!ua) return null;
    return IN_APP.find(([re]) => re.test(ua))?.[1] ?? null;
}

const NAV_TYPES: Record<string, string> = {
    navigate: 'link or address bar',
    reload: 'reload',
    back_forward: 'back / forward',
    prerender: 'prerendered'
};

const VISIBILITY: Record<string, string> = {
    visible: 'visible',
    hidden: 'background tab',
    prerender: 'prerendered, not yet shown'
};

/** "1440×900 · 132 px of toolbars" from the outer size and the page's own size. */
function frame(c: ClickHistoryRow): string | null {
    if (!c.outerSize) return null;
    const [ow, oh] = c.outerSize.split('x').map(Number);
    const ih = c.viewport ? Number(c.viewport.split('x')[1]) : null;
    const toolbars = oh && ih !== null && oh > ih ? ` · ${oh - ih} px of toolbars` : '';
    return `${ow}×${oh}${toolbars}`;
}

/** "Brave (user agent says Chrome)", or just the browser when they agree. */
function realBrowser(c: ClickHistoryRow): string | null {
    if (!c.browserBrand) return null;
    if (c.browser?.startsWith(c.browserBrand)) return c.browserBrand;
    return `${c.browserBrand} (user agent says ${c.browser ?? 'unknown'})`;
}

/** Webdriver plus any automation leftovers, or "none found". */
function automation(c: ClickHistoryRow): ReactNode {
    const tells = [...(c.webdriver ? ['webdriver on'] : []), ...(c.automation ?? [])];
    if (tells.length > 0) {
        return (
            <ul className="click-details-issues">
                {tells.map(tell => (
                    <li key={tell}>{tell}</li>
                ))}
            </ul>
        );
    }
    return c.webdriver === null && c.automation === null ? null : 'none found';
}

/** "0.005 ms", flagged when coarse enough to mean Tor or resist-fingerprinting. */
function timer(ms: number): string {
    return ms >= 1 ? `${ms} ms (coarsened: Tor or anti-fingerprinting)` : `${ms} ms`;
}

function yesNo(value: boolean | null, yes = 'yes', no = 'no'): string | null {
    return value === null ? null : value ? yes : no;
}

/** Words that say nothing about which company a network belongs to. */
const NETWORK_FILLER = new Set([
    'inc',
    'llc',
    'ltd',
    'limited',
    'corp',
    'corporation',
    'co',
    'company',
    'gmbh',
    'sa',
    'ag',
    'bv',
    'plc',
    'srl',
    'the',
    'and',
    'of',
    'communications',
    'communication',
    'telecom',
    'telecommunications',
    'network',
    'networks',
    'internet',
    'services',
    'service',
    'cable',
    'broadband',
    'online',
    'holdings',
    'group',
    'as',
    'isp',
    'net'
]);

/** The distinctive words of a network name: "Comcast Cable Communications, LLC" -> comcast. */
function networkWords(name: string): Set<string> {
    return new Set(
        name
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(w => w.length >= 3 && !NETWORK_FILLER.has(w) && !/^\d+$/.test(w))
    );
}

/** Whether two network names plausibly name the same operator (they share a distinctive word). */
export function sameNetwork(a: string, b: string): boolean {
    const wa = networkWords(a);
    const wb = networkWords(b);
    if (wa.size === 0 || wb.size === 0) return true;
    for (const w of wa) {
        for (const v of wb) {
            if (
                w === v ||
                (w.length >= 4 && v.startsWith(w)) ||
                (v.length >= 4 && w.startsWith(v))
            ) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Traits that contradict each other: common with VPNs, spoofed user agents and
 * automation, though each has innocent causes too (travel, desktop mode, a wrong clock).
 */
export function inconsistencies(c: ClickHistoryRow): string[] {
    const out: string[] = [];
    // `timezone` only differs from the IP's once the browser has reported its own.
    if (c.js && c.ipTimezone && c.timezone && c.ipTimezone !== c.timezone) {
        const browser = utcOffset(c.timezone, c.ts);
        const ip = utcOffset(c.ipTimezone, c.ts);
        if (browser && ip && browser !== ip) {
            out.push(
                `Browser timezone ${c.timezone} (${browser}) ≠ IP timezone ${c.ipTimezone} (${ip})`
            );
        }
    }
    const uaOs = osFamily(c.os);
    const hintOs = osFamily(c.platform);
    if (uaOs && hintOs && uaOs !== hintOs) {
        out.push(`User agent says ${c.os ?? ''}, browser reports ${c.platform ?? ''}`);
    }
    const header = c.acceptLanguage?.split(/[,;]/)[0]?.trim().toLowerCase();
    const preferred = c.languages?.[0]?.toLowerCase();
    if (header && preferred && header.split('-')[0] !== preferred.split('-')[0]) {
        out.push(`Accept-Language starts with ${header}, browser prefers ${preferred}`);
    }
    if (c.formFactors && c.device) {
        const hintsMobile = /mobile|tablet/i.test(c.formFactors) && !/desktop/i.test(c.formFactors);
        const uaMobile = c.device === 'mobile' || c.device === 'tablet';
        if (hintsMobile !== uaMobile) {
            out.push(`Client hints say ${c.formFactors}, user agent says ${c.device}`);
        }
    }
    const navOs = navPlatformFamily(c.navPlatform);
    const linuxLike = uaOs === 'linux' || uaOs === 'android' || uaOs === 'chromeos';
    // iPads ask for desktop sites as a Mac: platform "MacIntel" with a Mac user agent,
    // so a Mac platform under an iOS user agent isn't a contradiction either.
    const ipad = navOs === 'macos' && uaOs === 'ios';
    if (navOs && uaOs && navOs !== uaOs && !(navOs === 'linux' && linuxLike) && !ipad) {
        out.push(`User agent says ${c.os ?? ''}, navigator.platform is ${c.navPlatform ?? ''}`);
    }
    const vendor = expectedVendor(c.browser);
    // Every iOS browser is Safari's engine underneath, so its vendor is always Apple's.
    if (c.navVendor !== null && vendor !== null && uaOs !== 'ios' && c.navVendor !== vendor) {
        out.push(`${c.browser ?? ''} should report vendor "${vendor}", got "${c.navVendor}"`);
    }
    if (c.isp && c.asOrg && !sameNetwork(c.isp, c.asOrg)) {
        out.push(`AbuseIPDB says ISP ${c.isp}, Cloudflare says network ${c.asOrg}`);
    }
    if (c.clockSkew !== null && Math.abs(c.clockSkew) > CLOCK_TOLERANCE_MS) {
        out.push(`Device clock ${duration(c.clockSkew)} ${c.clockSkew > 0 ? 'ahead' : 'behind'}`);
    }
    return out;
}

/** "k=v, k=v". */
function pairs(record: Record<string, string> | null): string | null {
    if (!record) return null;
    return Object.entries(record)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
}

/** "in sync (+1.2 s)" or "4 min ahead". */
function clock(skew: number): string {
    if (Math.abs(skew) > CLOCK_TOLERANCE_MS) {
        return `${duration(skew)} ${skew > 0 ? 'ahead' : 'behind'}`;
    }
    return `in sync (${skew >= 0 ? '+' : '−'}${duration(skew)})`;
}

/** The page's report: "after 420 ms", "none", or null when no page was served. */
function pageReport(c: ClickHistoryRow): string | null {
    if (c.js === null) return null;
    if (!c.js) return 'none';
    return c.reportMs === null ? 'received' : `after ${duration(c.reportMs)}`;
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
        c.js,
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
    const gpu = c.gpu ? gpuParts(c.gpu, text(webgl?.vendor)) : null;
    const devices = c.mediaDevices;
    const count = (key: string) => (typeof devices?.[key] === 'number' ? devices[key] : 0);
    const gamut = typeof f?.gamut === 'string' ? (GAMUTS[f.gamut] ?? f.gamut) : null;
    const issues = inconsistencies(c);
    const ipOffset = c.ipTimezone && utcOffset(c.ipTimezone, c.ts);

    return (
        <div className="click-details">
            <div className="click-details-grid">
                <Section
                    title="Signals"
                    rows={[
                        [
                            'Checks',
                            c.js &&
                                (issues.length > 0 ? (
                                    <ul className="click-details-issues">
                                        {issues.map(issue => (
                                            <li key={issue}>{issue}</li>
                                        ))}
                                    </ul>
                                ) : (
                                    'nothing contradicts'
                                ))
                        ],
                        ['Real browser', realBrowser(c)],
                        ['Automation', automation(c)],
                        ['Timer', c.timerMs === null ? null : timer(c.timerMs)],
                        ['Page report', pageReport(c)],
                        ['Device clock', c.clockSkew === null ? null : clock(c.clockSkew)]
                    ]}
                />
                <Section
                    title="Context"
                    rows={[
                        ['In-app browser', inAppBrowser(c.userAgent)],
                        ['Opened by', c.navType && (NAV_TYPES[c.navType] ?? c.navType)],
                        [
                            'Back history',
                            c.historyLength === null
                                ? null
                                : c.historyLength <= 1
                                  ? 'fresh tab (likely opened from an app)'
                                  : `${c.historyLength} pages`
                        ],
                        ['Visibility', c.visibility && (VISIBILITY[c.visibility] ?? c.visibility)],
                        ['Opener', yesNo(c.hasOpener, 'opened by another window', 'none')],
                        ['Page referrer', c.pageReferrer]
                    ]}
                />
                <Section
                    title="Request"
                    rows={[
                        ['Referrer', c.referrer],
                        ['UTM', pairs(c.utm)],
                        ['Query', pairs(c.query)],
                        ['Accept-Language', c.acceptLanguage],
                        [
                            'IP timezone',
                            c.ipTimezone && `${c.ipTimezone}${ipOffset ? ` (${ipOffset})` : ''}`
                        ],
                        ['Visitor', mono(c.visitorHash)]
                    ]}
                />
                <Section
                    title="Network"
                    rows={[
                        [
                            'Network',
                            c.asn || c.asOrg
                                ? [c.asn && `AS${c.asn}`, c.asOrg].filter(Boolean).join(' · ')
                                : null
                        ],
                        [
                            'Place',
                            [c.postalCode, c.regionCode, c.continent].filter(Boolean).join(' · ')
                        ],
                        ['US metro', c.metroCode],
                        ['Edge', c.edgeColo && `Cloudflare ${c.edgeColo}`]
                    ]}
                />
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
                        ],
                        ['Refresh rate', c.refreshHz === null ? null : `${c.refreshHz} Hz`],
                        ['Browser frame', frame(c)],
                        [
                            'Font size',
                            c.fontSize === null
                                ? null
                                : `${c.fontSize} px${c.fontSize === 16 ? ' (default)' : ' (changed)'}`
                        ],
                        [
                            'Scrollbars',
                            c.scrollbar === null
                                ? null
                                : c.scrollbar === 0
                                  ? 'overlay'
                                  : `classic, ${c.scrollbar} px`
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
                        ['Model', c.deviceModel],
                        ['Form factor', c.formFactors],
                        ['Architecture', c.cpuArch],
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
                        [
                            'Network',
                            [
                                c.connection,
                                c.downlink === null ? null : `~${c.downlink} Mbps`,
                                c.rtt === null ? null : `${c.rtt} ms RTT`,
                                c.saveData ? 'Data Saver' : null
                            ]
                                .filter(Boolean)
                                .join(' · ')
                        ],
                        ['Storage', c.quota === null ? null : `${formatBytes(c.quota)} quota`],
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
                        ],
                        ['Biometrics', yesNo(c.biometrics, 'available', 'none')],
                        ['Bluetooth', yesNo(c.bluetooth, 'available', 'none')],
                        [
                            'JS heap',
                            c.heapLimit === null ? null : `${formatBytes(c.heapLimit)} limit`
                        ],
                        ['CPU test', c.cpuMs === null ? null : `${c.cpuMs} ms (lower is faster)`],
                        [
                            'Platform',
                            [c.navPlatform, c.navVendor, c.oscpu].filter(Boolean).join(' · ')
                        ]
                    ]}
                />
                <Section
                    title="Graphics"
                    rows={[
                        ['GPU', gpu?.name],
                        ['Vendor', gpu?.vendor],
                        ['Backend', gpu?.backend],
                        ['Shader model', gpu?.shaderModel],
                        ['Device ID', mono(gpu?.deviceId ?? null)],
                        [
                            'WebGPU',
                            c.webgpu &&
                                [c.webgpu.vendor, c.webgpu.architecture, c.webgpu.device]
                                    .filter(Boolean)
                                    .join(' · ')
                        ],
                        ['WebGPU name', text(c.webgpu?.description)],
                        ['WebGL', text(webgl?.version)],
                        ['GLSL', text(webgl?.shading)],
                        [
                            'Max texture',
                            typeof webgl?.maxTexture === 'number' &&
                                `${webgl.maxTexture}×${webgl.maxTexture}`
                        ],
                        ['Max viewport', text(webgl?.maxViewport)?.replace('-', '×')],
                        ['Precision', webgl && precision(webgl.precision)],
                        [
                            'Antialiasing',
                            typeof webgl?.antialias === 'boolean'
                                ? webgl.antialias
                                    ? 'on'
                                    : 'off'
                                : null
                        ],
                        ['Renderer', mono(c.gpu)]
                    ]}
                />
                <Section
                    title="Privacy & hashes"
                    rows={[
                        ['Settings', settings(c)],
                        ['Private', c.incognito === null ? null : c.incognito ? 'yes' : 'no'],
                        ['Ad blocker', c.adBlocker === null ? null : c.adBlocker ? 'yes' : 'no'],
                        ['Permissions', c.permissions && permissions(c.permissions)],
                        [
                            'Storage',
                            c.blockedStorage &&
                                (c.blockedStorage.length > 0
                                    ? `blocked: ${c.blockedStorage.join(', ')}`
                                    : 'all available')
                        ],
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
