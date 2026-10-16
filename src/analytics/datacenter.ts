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
    'cloudflare.com' // Cloudflare egress (WARP / proxies)
] as const;

const SUFFIX_RE = new RegExp(
    `(?:^|\\.)(?:${DATACENTER_SUFFIXES.map(s => s.replaceAll('.', String.raw`\.`)).join('|')})$`,
    'i'
);

/** True when the reverse-DNS hostname belongs to a hosting/datacenter provider. */
export function isDatacenterHostname(hostname?: string | null): boolean {
    if (!hostname) return false;
    return SUFFIX_RE.test(hostname.replace(/\.$/, ''));
}
