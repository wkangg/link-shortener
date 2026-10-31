// What the device-signals page probes for (see redirect/interstitial.ts), and how
// to read the compact strings it reports back. The browser sends one digit per
// entry, in this order, so entries are only ever appended: reordering changes
// every fingerprint and misreads stored clicks.

/** Media types checked with canPlayType / MediaSource, with a readable name. */
export const CODECS: readonly (readonly [mime: string, label: string])[] = [
    ['video/mp4; codecs="avc1.42E01E"', 'H.264'],
    ['video/mp4; codecs="hev1.1.6.L93.B0"', 'HEVC'],
    ['video/mp4; codecs="av01.0.05M.08"', 'AV1 (MP4)'],
    ['video/webm; codecs="vp8"', 'VP8'],
    ['video/webm; codecs="vp9"', 'VP9'],
    ['video/webm; codecs="av01.0.05M.08"', 'AV1 (WebM)'],
    ['video/ogg; codecs="theora"', 'Theora'],
    ['video/mp2t; codecs="avc1.42E01E"', 'MPEG-TS'],
    ['application/vnd.apple.mpegurl', 'HLS'],
    ['audio/mp4; codecs="mp4a.40.2"', 'AAC (MP4)'],
    ['audio/mp4; codecs="ac-3"', 'AC-3'],
    ['audio/mp4; codecs="ec-3"', 'E-AC-3'],
    ['audio/mp4; codecs="flac"', 'FLAC (MP4)'],
    ['audio/mp4; codecs="opus"', 'Opus (MP4)'],
    ['audio/webm; codecs="opus"', 'Opus (WebM)'],
    ['audio/ogg; codecs="vorbis"', 'Vorbis'],
    ['audio/mpeg', 'MP3'],
    ['audio/wav; codecs="1"', 'WAV'],
    ['audio/flac', 'FLAC'],
    ['audio/aac', 'AAC']
];

/** Fonts detected by measuring text: a mix of Windows, macOS, Linux and popular installs. */
export const FONTS: readonly string[] = [
    'Arial Black',
    'Calibri',
    'Cambria',
    'Candara',
    'Comic Sans MS',
    'Consolas',
    'Constantia',
    'Corbel',
    'Courier New',
    'Georgia',
    'Impact',
    'Lucida Console',
    'Segoe UI',
    'Tahoma',
    'Trebuchet MS',
    'Verdana',
    'MS Gothic',
    'Microsoft YaHei',
    'Helvetica Neue',
    'Menlo',
    'Monaco',
    'Avenir',
    'Futura',
    'Gill Sans',
    'Optima',
    'Hiragino Sans',
    'PingFang SC',
    'Ubuntu',
    'DejaVu Sans',
    'Liberation Sans',
    'Noto Sans',
    'Cantarell',
    'Roboto',
    'Source Code Pro',
    'Fira Code',
    'Open Sans',
    'Lato',
    'Montserrat',
    'Inter',
    'JetBrains Mono'
];

/** Browser settings, in the order the page reports them: label when on, and when off. */
export const SETTINGS: readonly (readonly [on: string, off: string | null])[] = [
    ['cookies on', 'cookies off'],
    ['Do Not Track', null],
    ['Global Privacy Control', null],
    ['PDF viewer', 'no PDF viewer'],
    ['reduced motion', null],
    ['more contrast', null],
    ['forced colors', null],
    ['reduced transparency', null],
    ['inverted colors', null]
];

/**
 * Codecs the browser can play. Each digit is canPlayType (0 no, 1 maybe,
 * 2 probably), plus 3 when MediaSource also supports it.
 */
export function codecNames(digits: string | null): string[] | null {
    if (digits === null) return null;
    return CODECS.filter((_, i) => Number(digits[i] ?? 0) > 0).map(([, label]) => label);
}

/** Fonts the browser reported as installed. */
export function fontNames(bits: string | null): string[] | null {
    if (bits === null) return null;
    return FONTS.filter((_, i) => bits[i] === '1');
}

/** Readable browser settings; settings that are off and unremarkable are left out. */
export function settingNames(bits: string | null): string[] | null {
    if (bits === null) return null;
    const out: string[] = [];
    for (const [i, [on, off]] of SETTINGS.entries()) {
        if (i >= bits.length) break;
        const label = bits[i] === '1' ? on : off;
        if (label) out.push(label);
    }
    return out;
}
