// Loopback, private, link-local and CGNAT ranges: addresses no outside service knows anything about.
const PRIVATE_V4_RE =
    /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/;
const PRIVATE_V6_RE = /^(?:::1?$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 address.
const MAPPED_V4_RE = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** True for loopback, private, link-local and CGNAT addresses (IPv4, IPv6 or IPv4-mapped). */
export function isPrivateIp(ip: string): boolean {
    const v4 = MAPPED_V4_RE.exec(ip)?.[1] ?? ip;
    return PRIVATE_V4_RE.test(v4) || PRIVATE_V6_RE.test(v4);
}
