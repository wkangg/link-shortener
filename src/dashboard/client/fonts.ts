import bricolageUrl from '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2';
import geistMonoUrl from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2';
import geistUrl from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2';

// Registered from JS rather than CSS: Bun inlines url() fonts into the stylesheet, which
// made it ~10x larger and re-downloaded the fonts on every CSS change. As separate assets
// they cache on their own and load while the first API call is in flight. Latin only;
// anything else falls back per character to the next family in the stack.
const FONTS = [
    { family: 'Bricolage Grotesque Variable', url: bricolageUrl, weight: '200 800' },
    { family: 'Geist Variable', url: geistUrl, weight: '100 900' },
    { family: 'Geist Mono Variable', url: geistMonoUrl, weight: '100 900' }
];

export function loadFonts(): void {
    for (const { family, url, weight } of FONTS) {
        const face = new FontFace(family, `url(${url}) format('woff2')`, {
            weight,
            display: 'swap'
        });
        document.fonts.add(face);
        void face.load();
    }
}
