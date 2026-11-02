import { describe, expect, test } from 'bun:test';

import { codecNames, fontNames, settingNames } from '../src/shared/probes.ts';

describe('probe decoding', () => {
    test('codecs: any non-zero digit is playable', () => {
        expect(codecNames('0215')).toEqual(['HEVC', 'AV1 (MP4)', 'VP8']);
        expect(codecNames('')).toEqual([]);
        expect(codecNames(null)).toBeNull();
    });

    test('fonts: one bit per font, short strings read as missing', () => {
        expect(fontNames('101')).toEqual(['Arial Black', 'Cambria']);
        expect(fontNames(null)).toBeNull();
    });

    test('settings: on labels, plus notable offs', () => {
        expect(settingNames('010100000')).toEqual(['cookies off', 'Do Not Track', 'PDF viewer']);
        expect(settingNames('1000')).toEqual(['cookies on', 'no PDF viewer']);
        expect(settingNames(null)).toBeNull();
    });
});
