// A device fingerprint: a short hash over the most stable identifying traits of
// a visitor's browser. The visitor_hash answers "how many unique people" (it
// mixes in the IP, so it changes with the network); the fingerprint answers "is
// this the same device as before", surviving a changed IP. It is deliberately coarse — many devices share one — so it's a signal for
// grouping clicks, never a unique-person identifier.

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

/**
 * A stable base36 hash of the parts, or null when nothing identifying is known.
 * The same parts always hash to the same value; the field order is fixed so a
 * value is comparable across clicks.
 */
export function computeFingerprint(parts: FingerprintParts): string | null {
    const fields = ORDER.map(key => {
        const value = parts[key];
        return value === null || value === undefined ? '' : String(value);
    });
    if (fields.every(f => f === '')) return null;
    return Bun.hash(fields.join('\u0001')).toString(36);
}
