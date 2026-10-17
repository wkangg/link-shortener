import type { Database } from 'bun:sqlite';

// Flags clicks whose IP reverse-resolves to a known hosting/datacenter provider.
// Traffic from these ranges is overwhelmingly bots, scrapers and link scanners
// wearing a browser-like user agent, so the dashboard hides it by default, the
// same way it hides declared crawlers.
//
// This is a hostname heuristic, not an ASN database: it only fires on clear,
// well-known provider domains, so it errs toward leaving real visitors visible.
// Reverse DNS is best-effort (see analytics/hostname.ts), so an unresolved IP is
// simply never flagged.

// Matched against the end of the reverse-DNS hostname (case-insensitive). These
// are the rDNS suffixes of the large cloud and hosting providers.
const DATACENTER_SUFFIXES = [
    'amazonaws.com', // AWS EC2
    'compute.amazonaws.com',
    'googleusercontent.com', // Google Cloud
    '1e100.net', // Google
    'bc.googleusercontent.com',
    'cloudapp.net', // Azure
    'cloudapp.azure.com',
    'azurewebsites.net',
    'digitalocean.com',
    'linodeusercontent.com', // Linode / Akamai
    'linode.com',
    'members.linode.com',
    'vultr.com',
    'vultrusercontent.com',
    'choopa.net', // Vultr / Constant
    'constant.com',
    'ovh.net', // OVH
    'ovh.ca',
    'ovh.us',
    'ovhcloud.com',
    'hetzner.com', // Hetzner
    'your-server.de',
    'clients.your-server.de',
    'scaleway.com', // Scaleway / Online
    'online.net',
    'contabo.net', // Contabo
    'contabo.host',
    'contaboserver.net',
    'leaseweb.com', // Leaseweb
    'leaseweb.net',
    'hostwinds.com',
    'oraclecloud.com', // Oracle Cloud
    'oracle.com',
    'softlayer.com', // IBM Cloud
    'ibm.com',
    'rackspace.com',
    'upcloud.com',
    'kamatera.com',
    'quadranet.com',
    'm247.com', // M247 (often behind VPNs)
    'datacamp.co.uk',
    'servers.com',
    'hostinger.com',
    'bacloud.info', // Bacloud
    'bacloud.com',
    'tzulo.com', // tzulo (often behind VPNs)
    'cloudflare.com' // Cloudflare egress (WARP / proxies)
] as const;

const SUFFIX_RE = new RegExp(
    `(?:^|\\.)(?:${DATACENTER_SUFFIXES.map(s => s.replaceAll('.', String.raw`\.`)).join('|')})$`,
    'i'
);

// OVH (and its Kimsufi / So you Start brands) names dedicated servers after the
// /24 they sit in rather than an OVH domain, e.g. ns5011203.ip-51-222-254.net.
const OVH_RE = /(?:^|\.)ip-\d{1,3}-\d{1,3}-\d{1,3}\.(?:net|eu|us)$/i;

/** True when the reverse-DNS hostname belongs to a hosting/datacenter provider. */
export function isDatacenterHostname(hostname?: string | null): boolean {
    if (!hostname) return false;
    const host = hostname.replace(/\.$/, '');
    return SUFFIX_RE.test(host) || OVH_RE.test(host);
}

/**
 * Flags clicks whose stored hostname is a datacenter's but that aren't flagged yet:
 * clicks recorded before this check existed, or before a provider was added to the
 * list. Runs at startup. Returns the number of clicks flagged.
 */
export function backfillDatacenterHostnames(db: Database): number {
    const hostnames = db
        .query<{ hostname: string }, []>(
            'SELECT DISTINCT hostname FROM clicks WHERE hostname IS NOT NULL AND is_datacenter = 0'
        )
        .all()
        .map(row => row.hostname)
        .filter(hostname => isDatacenterHostname(hostname));
    const flag = db.query('UPDATE clicks SET is_datacenter = 1 WHERE hostname = ?');
    let flagged = 0;
    db.transaction(() => {
        for (const hostname of hostnames) flagged += flag.run(hostname).changes;
    })();
    return flagged;
}
