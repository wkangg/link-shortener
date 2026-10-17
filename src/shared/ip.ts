// Loopback, private, link-local and CGNAT ranges: addresses no outside service knows anything about.
const PRIVATE_V4_RE =
    /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/;
const PRIVATE_V6_RE = /^(?:::1?$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;
// IPv4-mapped IPv6 is the IPv4 address, written dotted (::ffff:a.b.c.d) or in hex
// (::ffff:7f00:1, which is how URLs normalize it).
const MAPPED_V4_RE = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const MAPPED_V4_HEX_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

function mappedV4(ip: string): string | null {
    const dotted = MAPPED_V4_RE.exec(ip)?.[1];
    if (dotted) return dotted;
    const hex = MAPPED_V4_HEX_RE.exec(ip);
    if (!hex) return null;
    const [hi, lo] = [Number.parseInt(hex[1] ?? '', 16), Number.parseInt(hex[2] ?? '', 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for loopback, private, link-local and CGNAT addresses (IPv4, IPv6 or IPv4-mapped). */
export function isPrivateIp(ip: string): boolean {
    const v4 = mappedV4(ip) ?? ip;
    return PRIVATE_V4_RE.test(v4) || PRIVATE_V6_RE.test(v4);
}
