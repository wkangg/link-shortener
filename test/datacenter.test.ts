import { describe, expect, test } from 'bun:test';

import { isDatacenterHostname } from '../src/analytics/datacenter.ts';

describe('isDatacenterHostname', () => {
    test('flags well-known hosting / datacenter rDNS', () => {
        for (const host of [
            'ec2-3-14-15-92.us-east-2.compute.amazonaws.com',
            '192-241-220-11.digitalocean.com',
            'static.123.45.67.89.clients.your-server.de',
            '95.179.128.1.vultrusercontent.com',
            'li1234-5.members.linode.com',
            'something.1e100.net',
            'host.oraclecloud.com'
        ]) {
            expect(isDatacenterHostname(host)).toBe(true);
        }
        // Trailing dot (fully-qualified) still matches.
        expect(isDatacenterHostname('box.amazonaws.com.')).toBe(true);
    });

    test('leaves residential / ISP hostnames alone', () => {
        for (const host of [
            'c-73-12-34-56.hsd1.ca.comcast.net',
            'cpe-100-200-30-40.rogers.com',
            'dsl-189-1-2-3.prod-infinitum.com.mx',
            'broadband.actcorp.in'
        ]) {
            expect(isDatacenterHostname(host)).toBe(false);
        }
    });

    test('must match a domain boundary, not a substring', () => {
        // A lookalike that merely contains the provider name is not flagged.
        expect(isDatacenterHostname('not-amazonaws.com.evil.example')).toBe(false);
        expect(isDatacenterHostname('myovh.net.example.com')).toBe(false);
    });

    test('empty and missing hostnames are not datacenters', () => {
        expect(isDatacenterHostname(null)).toBe(false);
        expect(isDatacenterHostname()).toBe(false);
        expect(isDatacenterHostname('')).toBe(false);
    });
});
