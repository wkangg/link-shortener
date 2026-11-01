// Runs in front of the short-link domain and tells the origin which
// network the visitor's IP belongs to. Cloudflare reserves cf-* header names,
// hence x-*. Setting (not appending) overwrites anything the visitor sent.
export default {
    async fetch(request: Request): Promise<Response> {
        const cf = (request as Request & { cf?: { asn?: number; asOrganization?: string } }).cf;
        const headers = new Headers(request.headers);
        headers.set('x-asn', cf?.asn ? String(cf.asn) : '');
        headers.set('x-as-org', cf?.asOrganization ?? '');
        return fetch(new Request(request, { headers }));
    }
};
