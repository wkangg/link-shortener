import { describe, expect, test } from 'bun:test';

import { isPublicIp } from '../src/analytics/hostname.ts';
import { isPrivateIp } from '../src/shared/ip.ts';

describe('isPrivateIp', () => {
    test.each([
        '127.0.0.1',
        '10.1.2.3',
        '192.168.8.170',
        '172.16.0.1',
        '172.31.255.255',
        '169.254.1.1',
        '100.64.0.1',
        '0.0.0.0',
        '::1',
        '::',
        'fd12:3456::1',
        'fe80::1',
        '::ffff:192.168.8.170',
        '::FFFF:127.0.0.1',
        '::ffff:7f00:1',
        '::ffff:a9fe:a9fe'
    ])('%s is private', ip => expect(isPrivateIp(ip)).toBe(true));

    test.each([
        '8.8.8.8',
        '172.32.0.1',
        '100.128.0.1',
        '2606:6d00:341:fb00:851e:876d:c657:96f3',
        '::ffff:8.8.8.8',
        '::ffff:808:808'
    ])('%s is public', ip => expect(isPrivateIp(ip)).toBe(false));
});

describe('isPublicIp', () => {
    test('rejects private and invalid addresses', () => {
        expect(isPublicIp('8.8.8.8')).toBe(true);
        expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
        expect(isPublicIp('::ffff:10.0.0.1')).toBe(false);
        expect(isPublicIp('not an ip')).toBe(false);
    });
});
