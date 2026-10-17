import Bowser from 'bowser';
import { isbot, isbotMatch } from 'isbot';

import { iosVersion, modelFromHardwareId } from './apple.ts';

export interface UaInfo {
    browser: string | null;
    os: string | null;
    /** Only for iOS for now, e.g. "18.6" (see analytics/apple.ts). */
    osVersion: string | null;
    device: 'desktop' | 'mobile' | 'tablet' | 'tv' | null;
    isBot: boolean;
    /** Crawler name (e.g. "Googlebot", "curl") when `isBot`. */
    botName: string | null;
    /** Vendor and model, e.g. "Apple iPhone", "Apple iPhone 15 Pro" or "Pixel 8". */
    model: string | null;
}

// Android puts the model after the OS version: "Android 14; Pixel 8)" or "...; SM-S918B Build/...".
// Chrome's reduced UA sends "K" instead of the real model.
const ANDROID_MODEL_RE = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?\)/;

const MAX_CACHE = 2000;
const cache = new Map<string, UaInfo>();

/** Parses a user agent. Results are memoized: the same few UAs repeat constantly. */
export function parseUserAgent(ua: string): UaInfo {
    const cached = cache.get(ua);
    if (cached) return cached;

    let info: UaInfo;
    if (ua === '') {
        info = {
            browser: null,
            os: null,
            osVersion: null,
            device: null,
            isBot: false,
            botName: null,
            model: null
        };
    } else {
        const parsed = Bowser.parse(ua);
        const type = parsed.platform.type;
        const isBot = isbot(ua) || type === 'bot';
        info = {
            // Bowser reports unrecognized browsers as an empty name rather than undefined.
            browser: parsed.browser.name || null,
            os: parsed.os.name || null,
            osVersion: parsed.os.name === 'iOS' ? iosVersion(ua) : null,
            device:
                type === 'desktop' || type === 'mobile' || type === 'tablet' || type === 'tv'
                    ? type
                    : null,
            isBot,
            botName: isBot ? botName(ua, type === 'bot' ? parsed.browser.name : undefined) : null,
            model: type === 'bot' ? null : deviceModel(ua, parsed.platform)
        };
    }

    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(ua, info);
    return info;
}

function botName(ua: string, known: string | undefined): string | null {
    if (known) return known;
    // isbot's match is the matching fragment, e.g. "curl/8.4.0" or "python-requests/2.31".
    const match = isbotMatch(ua);
    return match ? match.split('/')[0]?.trim() || match : null;
}

function deviceModel(ua: string, platform: { vendor?: string; model?: string }): string | null {
    if (platform.vendor === 'Apple') {
        const exact = modelFromHardwareId(ua);
        if (exact) return exact;
    }
    const model = platform.model ?? ANDROID_MODEL_RE.exec(ua)?.[1]?.trim();
    if (model === 'K') return platform.vendor ?? null;
    const full = [platform.vendor, model].filter(Boolean).join(' ');
    return full || null;
}
