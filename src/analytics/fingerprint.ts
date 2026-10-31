// A device fingerprint: a short hash over the most stable identifying traits of
// a visitor's browser. The visitor_hash answers "how many unique people" (it
// mixes in the IP, so it changes with the network); the fingerprint answers "is
// this the same device as before", surviving a changed IP. Header-only clicks get
// a coarse hash many devices share; with the device-signals page's traits
// (codecs, fonts, settings, display) it gets much more specific. Either way it's
// a signal for grouping clicks, never a unique-person identifier.

/** The traits a fingerprint is built from. All optional; missing ones are skipped. */
export interface FingerprintParts {
    /** User-Agent header. */
    ua?: string | null;
    /** First Accept-Language tag, or navigator.language when reported. */
    language?: string | null;
    /** IANA timezone. */
    timezone?: string | null;
    /** "1920x1080@2" (CSS pixels @ devicePixelRatio). */
    screen?: string | null;
    /** WebGL unmasked renderer. */
    gpu?: string | null;
    /** Platform from client hints, e.g. "Windows 11". */
    platform?: string | null;
    /** navigator.deviceMemory in GB. */
    memory?: number | null;
    /** navigator.maxTouchPoints. */
    touchPoints?: number | null;
    /** Full browser version(s) from client hints, e.g. "Google Chrome 130.0.6723.92". */
    browserVersion?: string | null;
    /** Available screen size and color depth, e.g. "1920x1040x24". */
    display?: string | null;
    /** One digit per probed media type: how well it plays (see interstitial.ts). */
    codecs?: string | null;
    /** One bit per probed font: installed or not. */
    fonts?: string | null;
    /** One bit per probed browser setting (cookies, Do Not Track, reduced motion…). */
    settings?: string | null;
}

const ORDER: (keyof FingerprintParts)[] = [
    'ua',
    'language',
    'timezone',
    'screen',
    'gpu',
    'platform',
    'memory',
    'touchPoints'
];

// Added later, and hashed only when present, so header-only fingerprints keep
// the value they had before these existed.
const EXTRA: (keyof FingerprintParts)[] = [
    'browserVersion',
    'display',
    'codecs',
    'fonts',
    'settings'
];

/**
 * A stable base36 hash of the parts, or null when nothing identifying is known.
 * The same parts always hash to the same value; the field order is fixed so a
 * value is comparable across clicks.
 */
export function computeFingerprint(parts: FingerprintParts): string | null {
    const field = (key: keyof FingerprintParts) => {
        const value = parts[key];
        return value === null || value === undefined ? '' : String(value);
    };
    const fields = ORDER.map(key => field(key));
    const extra = EXTRA.map(key => field(key));
    if (extra.some(f => f !== '')) fields.push(...extra);
    if (fields.every(f => f === '')) return null;
    return Bun.hash(fields.join('\u0001')).toString(36);
}
