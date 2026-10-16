/** Search fields and flags, for the dashboard's autocomplete (analytics/search.ts compiles them). */

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
    { name: 'os', hint: 'operating system' },
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
