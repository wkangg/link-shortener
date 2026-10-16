import Bowser from 'bowser';
import { isbot } from 'isbot';

export interface UaInfo {
    browser: string | null;
    os: string | null;
    device: 'desktop' | 'mobile' | 'tablet' | 'tv' | null;
    isBot: boolean;
}

const MAX_CACHE = 2000;
const cache = new Map<string, UaInfo>();

/** Parses a user agent. Results are memoized: the same few UAs repeat constantly. */
export function parseUserAgent(ua: string): UaInfo {
    const cached = cache.get(ua);
    if (cached) return cached;

    let info: UaInfo;
    if (ua === '') {
        info = { browser: null, os: null, device: null, isBot: false };
    } else {
        const parsed = Bowser.parse(ua);
        const type = parsed.platform.type;
        info = {
            // Bowser reports unrecognized browsers as an empty name rather than undefined.
            browser: parsed.browser.name || null,
            os: parsed.os.name || null,
            device:
                type === 'desktop' || type === 'mobile' || type === 'tablet' || type === 'tv'
                    ? type
                    : null,
            isBot: isbot(ua) || type === 'bot'
        };
    }

    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(ua, info);
    return info;
}
