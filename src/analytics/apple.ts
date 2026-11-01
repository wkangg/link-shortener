/**
 * iPhone/iPad details the generic parser can't give: the real iOS version and,
 * where possible, the model.
 *
 * Safari's user agent only says "iPhone" or "iPad", and since iOS 26 its OS
 * version is frozen at 18_6 (the real version moved to the Safari `Version/`
 * token). In-app browsers (Instagram, Facebook, ...) often add the hardware
 * identifier and real version themselves. Otherwise the model can be narrowed
 * down from the screen size the device-signals page reports.
 */

/** Hardware identifiers, as in-app browsers report them. iPhone 8 onwards. */
const IPHONE_IDS: Record<string, string> = {
    'iPhone10,1': 'iPhone 8',
    'iPhone10,4': 'iPhone 8',
    'iPhone10,2': 'iPhone 8 Plus',
    'iPhone10,5': 'iPhone 8 Plus',
    'iPhone10,3': 'iPhone X',
    'iPhone10,6': 'iPhone X',
    'iPhone11,2': 'iPhone XS',
    'iPhone11,4': 'iPhone XS Max',
    'iPhone11,6': 'iPhone XS Max',
    'iPhone11,8': 'iPhone XR',
    'iPhone12,1': 'iPhone 11',
    'iPhone12,3': 'iPhone 11 Pro',
    'iPhone12,5': 'iPhone 11 Pro Max',
    'iPhone12,8': 'iPhone SE (2nd gen)',
    'iPhone13,1': 'iPhone 12 mini',
    'iPhone13,2': 'iPhone 12',
    'iPhone13,3': 'iPhone 12 Pro',
    'iPhone13,4': 'iPhone 12 Pro Max',
    'iPhone14,4': 'iPhone 13 mini',
    'iPhone14,5': 'iPhone 13',
    'iPhone14,2': 'iPhone 13 Pro',
    'iPhone14,3': 'iPhone 13 Pro Max',
    'iPhone14,6': 'iPhone SE (3rd gen)',
    'iPhone14,7': 'iPhone 14',
    'iPhone14,8': 'iPhone 14 Plus',
    'iPhone15,2': 'iPhone 14 Pro',
    'iPhone15,3': 'iPhone 14 Pro Max',
    'iPhone15,4': 'iPhone 15',
    'iPhone15,5': 'iPhone 15 Plus',
    'iPhone16,1': 'iPhone 15 Pro',
    'iPhone16,2': 'iPhone 15 Pro Max',
    'iPhone17,1': 'iPhone 16 Pro',
    'iPhone17,2': 'iPhone 16 Pro Max',
    'iPhone17,3': 'iPhone 16',
    'iPhone17,4': 'iPhone 16 Plus',
    'iPhone17,5': 'iPhone 16e',
    'iPhone18,1': 'iPhone 17 Pro',
    'iPhone18,2': 'iPhone 17 Pro Max',
    'iPhone18,3': 'iPhone 17',
    'iPhone18,4': 'iPhone Air',
    'iPhone19,2': 'iPhone 18 Pro',
    'iPhone19,3': 'iPhone 18 Pro Max',
    'iPhone19,4': 'iPhone Duo',
    'iPhone19,7': 'iPhone 18 Pro Max'
};

/**
 * Screen size in CSS pixels (portrait) @ devicePixelRatio. Several models share
 * each size, and Display Zoom makes a phone report a smaller one, so these are
 * best guesses.
 */
const IPHONE_SCREENS: Record<string, string> = {
    '320x568@2': 'iPhone SE (1st gen) or 5s',
    '375x667@2': 'iPhone 6s–8 or SE (2nd/3rd gen)',
    '414x736@3': 'iPhone 6s Plus–8 Plus',
    '375x812@3': 'iPhone X, XS, 11 Pro, 12 mini or 13 mini',
    '414x896@2': 'iPhone XR or 11',
    '414x896@3': 'iPhone XS Max or 11 Pro Max',
    '390x844@3': 'iPhone 12, 12 Pro, 13, 13 Pro, 14 or 16e',
    '428x926@3': 'iPhone 12 Pro Max, 13 Pro Max or 14 Plus',
    '393x852@3': 'iPhone 14 Pro, 15, 15 Pro or 16',
    '430x932@3': 'iPhone 14 Pro Max, 15 Plus, 15 Pro Max or 16 Plus',
    '402x874@3': 'iPhone 16 Pro, 17, 17 Pro or 18 Pro',
    '420x912@3': 'iPhone Air',
    '440x956@3': 'iPhone 16 Pro Max, 17 Pro Max or 18 Pro Max',
    '466x678@3': 'iPhone Duo (folded)',
    // Rendered at 3x and downsampled to the ~2.81x panel, like the old Plus models.
    '669x951@3': 'iPhone Duo (unfolded)'
};

const IPAD_SCREENS: Record<string, string> = {
    '768x1024@1': 'iPad 2 or mini (1st gen)',
    '768x1024@2': 'iPad (3rd–6th gen), Air (1st/2nd gen), mini (2nd–5th gen) or Pro 9.7″',
    '810x1080@2': 'iPad (7th–9th gen)',
    '834x1112@2': 'iPad Air (3rd gen) or Pro 10.5″',
    '820x1180@2': 'iPad (10th gen or later) or Air 11″',
    '834x1194@2': 'iPad Pro 11″ (1st–4th gen)',
    '834x1210@2': 'iPad Pro 11″ (M4 or later)',
    '744x1133@2': 'iPad mini (6th gen or later)',
    '1024x1366@2': 'iPad Pro 12.9″ or Air 13″',
    '1032x1376@2': 'iPad Pro 13″ (M4 or later)'
};

const OS_TOKEN_RE = /\bOS (\d+)_(\d+)(?:_(\d+))? like Mac OS X/;
const SAFARI_VERSION_RE = /\bVersion\/(\d+(?:\.\d+)*)/;
// Instagram: "(iPhone14,2; iOS 17_0; ...)". Facebook: "FBSV/17.0".
const IN_APP_VERSION_RE = /\b(?:iOS (\d+(?:_\d+)*)|FBSV\/(\d+(?:\.\d+)*))/;
const HARDWARE_ID_RE = /\b(iPhone\d+,\d+|iPad\d+,\d+)\b/;
const SCREEN_RE = /^(\d+)x(\d+)(?:@([\d.]+))?$/;

/** First version iOS reports only through Safari's `Version/` token. */
const FROZEN_FROM = 26;

/** The iOS/iPadOS version, e.g. "18.6" or "26.0", or null. */
export function iosVersion(ua: string): string | null {
    const inApp = IN_APP_VERSION_RE.exec(ua);
    if (inApp) return normalize((inApp[1] ?? inApp[2] ?? '').replaceAll('_', '.'));

    const token = OS_TOKEN_RE.exec(ua);
    const safari = SAFARI_VERSION_RE.exec(ua)?.[1];
    // iOS 26+ Safari sends "OS 18_6" with the real version in Version/.
    if (safari && Number(safari.split('.')[0]) >= FROZEN_FROM) return normalize(safari);
    if (!token) return null;
    return normalize([token[1], token[2], token[3]].filter(Boolean).join('.'));
}

/** The model named by an in-app browser's hardware identifier, or null. */
export function modelFromHardwareId(ua: string): string | null {
    const id = HARDWARE_ID_RE.exec(ua)?.[1];
    if (!id) return null;
    return `Apple ${IPHONE_IDS[id] ?? id}`;
}

/** iPhone or iPad models matching a reported screen ("390x844@3"), or null. */
export function modelFromScreen(screen: string, kind: 'iPhone' | 'iPad'): string | null {
    const m = SCREEN_RE.exec(screen);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const dpr = Math.round(Number(m[3] ?? 1));
    const key = `${Math.min(a, b)}x${Math.max(a, b)}@${dpr}`;
    const name = (kind === 'iPhone' ? IPHONE_SCREENS : IPAD_SCREENS)[key];
    return name ? `Apple ${name}` : null;
}

export interface AppleRefinement {
    os: string;
    device: 'mobile' | 'tablet';
    osVersion: string | null;
    model: string;
}

/**
 * Sharper details for an Apple mobile click once its browser signals are in,
 * or null when nothing changes. iPads in desktop mode (the default) claim to be
 * a Mac; a touch screen gives them away.
 */
export function refineApple(
    click: { ua: string | null; os: string | null; model: string | null },
    signals: { screen: string | null; touchPoints: number | null }
): AppleRefinement | null {
    const ua = click.ua ?? '';
    let kind: 'iPhone' | 'iPad';
    let osVersion: string | null;
    if (click.os === 'iOS') {
        kind = click.model === 'Apple iPad' || /\biPad\b/.test(ua) ? 'iPad' : 'iPhone';
        osVersion = iosVersion(ua);
    } else if (click.os === 'macOS' && (signals.touchPoints ?? 0) > 1) {
        kind = 'iPad';
        // The Mac UA's OS version is frozen at 10_15_7; Safari's tracks iPadOS.
        const safari = SAFARI_VERSION_RE.exec(ua)?.[1];
        osVersion = safari ? normalize(safari) : null;
    } else {
        return null;
    }
    // A hardware identifier is exact; keep it.
    const generic = !click.model || click.model === 'Apple' || click.model === `Apple ${kind}`;
    const model =
        (generic && signals.screen ? modelFromScreen(signals.screen, kind) : null) ??
        (generic ? `Apple ${kind}` : (click.model ?? `Apple ${kind}`));
    return { os: 'iOS', device: kind === 'iPad' ? 'tablet' : 'mobile', osVersion, model };
}

/** "17" → "17.0", "18.6.0" → "18.6". */
function normalize(version: string): string | null {
    const parts = version.split('.').filter(Boolean);
    if (parts.length === 0 || parts.some(p => !/^\d+$/.test(p))) return null;
    while (parts.length > 2 && parts.at(-1) === '0') parts.pop();
    if (parts.length === 1) parts.push('0');
    return parts.join('.');
}
