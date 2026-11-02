import { describe, expect, test } from 'bun:test';

import { sameNetwork } from '../src/dashboard/client/components/ClickDetails.tsx';

describe('sameNetwork', () => {
    test.each([
        ['Comcast Cable Communications, LLC', 'COMCAST-7922'],
        ['Rogers Communications Canada Inc.', 'ROGERS-COMMUNICATIONS'],
        ['Amazon.com, Inc.', 'AMAZON-02'],
        ['DigitalOcean, LLC', 'DIGITALOCEAN-ASN'],
        ['Cloudflare, Inc.', 'CLOUDFLARENET'],
        ['Bell Canada', 'Bell Canada']
    ])('ISP %p and AS org %p name the same operator', (isp, asOrg) => {
        expect(sameNetwork(isp, asOrg)).toBe(true);
    });

    test.each([
        ['Comcast Cable Communications, LLC', 'DigitalOcean, LLC'],
        ['Rogers Communications Canada Inc.', 'M247 Europe SRL']
    ])('ISP %p and AS org %p disagree', (isp, asOrg) => {
        expect(sameNetwork(isp, asOrg)).toBe(false);
    });

    test('names with nothing distinctive are not called a mismatch', () => {
        expect(sameNetwork('Internet Services LLC', 'AS-NETWORK')).toBe(true);
    });
});
