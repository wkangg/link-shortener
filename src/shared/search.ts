/** Search fields and flags, for the dashboard's autocomplete (analytics/search.ts compiles them). */

/** The links search (dashboard/links.ts compiles it). */
export const LINK_SEARCH_FIELDS: readonly SearchField[] = [
    { name: 'slug', hint: 'short link, e.g. slug:promo' },
    { name: 'destination', hint: 'where it goes, e.g. destination:github.com (or url:)' },
    { name: 'title', hint: 'title' },
    { name: 'tag', hint: 'tag, e.g. tag:promo' },
    { name: 'webhook', hint: 'webhook name, e.g. webhook:discord' },
    { name: 'has', hint: 'e.g. has:webhook' }
];

/** Other names for links search fields. */
export const LINK_SEARCH_ALIASES: Record<string, string> = { url: 'destination' };

export const LINK_SEARCH_HAS: readonly SearchField[] = [
    { name: 'webhook', hint: 'sends clicks to a webhook' },
    { name: 'tag', hint: 'has at least one tag' },
    { name: 'tracking', hint: 'detailed device tracking is on' }
];

export interface SearchField {
    name: string;
    hint: string;
}

export const SEARCH_FIELDS: readonly SearchField[] = [
    { name: 'ip', hint: 'IP address' },
    { name: 'isp', hint: 'internet provider' },
    { name: 'host', hint: 'reverse DNS hostname' },
    { name: 'country', hint: 'country code' },
    { name: 'region', hint: 'region' },
    { name: 'city', hint: 'city' },
    { name: 'link', hint: 'short link slug' },
    { name: 'source', hint: 'traffic source' },
    { name: 'referrer', hint: 'referring page' },
    { name: 'os', hint: 'operating system or version, e.g. os:18.6' },
    { name: 'browser', hint: 'browser' },
    { name: 'device', hint: 'device type or model' },
    { name: 'model', hint: 'device model' },
    { name: 'ua', hint: 'user agent' },
    { name: 'bot', hint: 'bot name' },
    { name: 'vpn', hint: 'VPN or relay, e.g. vpn:tor' },
    { name: 'scraper', hint: 'why a click looks automated' },
    { name: 'lang', hint: 'language' },
    { name: 'tz', hint: 'timezone' },
    { name: 'fp', hint: 'device fingerprint' },
    { name: 'gpu', hint: 'graphics card' },
    { name: 'platform', hint: 'platform' },
    { name: 'screen', hint: 'screen size' },
    { name: 'orientation', hint: 'screen orientation' },
    { name: 'connection', hint: 'network type' },
    { name: 'ram', hint: 'memory in GB, e.g. ram:>=8' },
    { name: 'cores', hint: 'CPU cores, e.g. cores:>=8' },
    { name: 'battery', hint: 'battery %, e.g. battery:<20' },
    { name: 'touch', hint: 'touch points' },
    { name: 'abuse', hint: 'AbuseIPDB score' },
    { name: 'lat', hint: 'latitude' },
    { name: 'lon', hint: 'longitude' },
    { name: 'utm', hint: 'any UTM tag' },
    { name: 'utm_source', hint: 'UTM source' },
    { name: 'utm_medium', hint: 'UTM medium' },
    { name: 'utm_campaign', hint: 'UTM campaign' },
    { name: 'utm_term', hint: 'UTM term' },
    { name: 'utm_content', hint: 'UTM content' },
    { name: 'query', hint: 'query string' },
    { name: 'is', hint: 'a flag, e.g. is:bot' },
    { name: 'has', hint: 'the field is set, e.g. has:gpu' }
];

export const SEARCH_FLAGS: readonly SearchField[] = [
    { name: 'bot', hint: 'bots and crawlers' },
    { name: 'datacenter', hint: 'hosting / datacenter IPs' },
    { name: 'vpn', hint: 'VPN, Tor or relay (iCloud Private Relay, WARP)' },
    { name: 'scraper', hint: 'scripts and headless browsers' },
    { name: 'abusive', hint: 'IPs flagged as abusive on AbuseIPDB' },
    { name: 'private', hint: 'private / incognito window' },
    { name: 'adblock', hint: 'ad blocker detected' },
    { name: 'charging', hint: 'battery charging' },
    { name: 'qr', hint: 'opened from a QR code' },
    { name: 'touch', hint: 'touch screen' },
    { name: 'mobile', hint: 'phones' },
    { name: 'tablet', hint: 'tablets' },
    { name: 'desktop', hint: 'computers' }
];
