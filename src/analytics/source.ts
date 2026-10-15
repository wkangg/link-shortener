// Referrer host -> friendly channel name. Matched on the host or any parent domain.
const SOURCES = new Map<string, string>([
    ['t.co', 'X'],
    ['x.com', 'X'],
    ['twitter.com', 'X'],
    ['facebook.com', 'Facebook'],
    ['fb.com', 'Facebook'],
    ['messenger.com', 'Messenger'],
    ['instagram.com', 'Instagram'],
    ['threads.net', 'Threads'],
    ['threads.com', 'Threads'],
    ['linkedin.com', 'LinkedIn'],
    ['lnkd.in', 'LinkedIn'],
    ['reddit.com', 'Reddit'],
    ['news.ycombinator.com', 'Hacker News'],
    ['youtube.com', 'YouTube'],
    ['youtu.be', 'YouTube'],
    ['tiktok.com', 'TikTok'],
    ['pinterest.com', 'Pinterest'],
    ['bsky.app', 'Bluesky'],
    ['mastodon.social', 'Mastodon'],
    ['discord.com', 'Discord'],
    ['discordapp.com', 'Discord'],
    ['slack.com', 'Slack'],
    ['telegram.org', 'Telegram'],
    ['t.me', 'Telegram'],
    ['web.whatsapp.com', 'WhatsApp'],
    ['mail.google.com', 'Gmail'],
    ['outlook.live.com', 'Outlook'],
    ['outlook.office.com', 'Outlook'],
    ['mail.yahoo.com', 'Yahoo Mail'],
    ['github.com', 'GitHub'],
    ['google.com', 'Google'],
    ['bing.com', 'Bing'],
    ['duckduckgo.com', 'DuckDuckGo'],
    ['search.brave.com', 'Brave Search'],
    ['yandex.ru', 'Yandex'],
    ['baidu.com', 'Baidu'],
    ['chatgpt.com', 'ChatGPT'],
    ['claude.ai', 'Claude'],
    ['perplexity.ai', 'Perplexity']
]);

// Android apps send `android-app://<package>/` as the referrer.
const ANDROID_APPS = new Map<string, string>([
    ['com.slack', 'Slack'],
    ['com.discord', 'Discord'],
    ['com.google.android.gm', 'Gmail'],
    ['com.google.android.googlequicksearchbox', 'Google'],
    ['com.twitter.android', 'X'],
    ['com.reddit.frontpage', 'Reddit'],
    ['com.linkedin.android', 'LinkedIn'],
    ['org.telegram.messenger', 'Telegram'],
    ['com.whatsapp', 'WhatsApp'],
    ['com.facebook.katana', 'Facebook'],
    ['com.instagram.android', 'Instagram']
]);

/** The host part of a referrer, without `www.`. Null when absent or unparseable. */
export function referrerHost(referrer: string): string | null {
    if (referrer === '') return null;
    try {
        const url = new URL(referrer);
        if (url.protocol === 'android-app:') return url.hostname || null;
        return url.hostname.replace(/^www\./, '') || null;
    } catch {
        return null;
    }
}

export function sourceForHost(host: string | null): string | null {
    if (host === null) return null;
    const app = ANDROID_APPS.get(host);
    if (app) return app;
    let h = host;
    for (;;) {
        const name = SOURCES.get(h);
        if (name) return name;
        const dot = h.indexOf('.');
        if (dot === -1 || !h.includes('.', dot + 1)) return null;
        h = h.slice(dot + 1);
    }
}

/** QR scan, then utm_source, then a known site name, then the raw host, then Direct. */
export function deriveSource(opts: {
    qr: boolean;
    utmSource: string | null;
    host: string | null;
}): string {
    if (opts.qr) return 'QR';
    if (opts.utmSource) return opts.utmSource;
    return sourceForHost(opts.host) ?? opts.host ?? 'Direct';
}
