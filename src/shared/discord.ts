// Discord webhook URLs, shared by the server and the dashboard. No runtime imports.

const HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
// /api/webhooks/<id>/<token>, optionally with an API version.
const PATH_RE = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/;

/** True for a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>). */
export function isDiscordWebhookUrl(raw: string): boolean {
    if (!URL.canParse(raw)) return false;
    const url = new URL(raw);
    return url.protocol === 'https:' && HOSTS.has(url.hostname) && PATH_RE.test(url.pathname);
}

/** The URL with its token hidden, safe to show and return from the API. */
export function maskDiscordUrl(raw: string): string {
    const url = new URL(raw);
    const match = PATH_RE.exec(url.pathname);
    return match ? `${url.origin}/api/webhooks/${match[1]}/••••` : raw;
}
