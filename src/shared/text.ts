const utf8 = new TextDecoder('utf-8', { fatal: true });
const ASCII_END = 128;
const LATIN1_END = 256;

/**
 * Undoes UTF-8 read as Latin-1 ("MontrÃ©al" → "Montréal").
 *
 * Cloudflare sends visitor-location headers (cf-ipcity, cf-region) as raw UTF-8
 * bytes, and HTTP header values are read one byte per character. If the string
 * is all single-byte characters and those bytes are valid UTF-8, decode them;
 * otherwise return it unchanged, so already-correct text is left alone.
 */
export function fixUtf8ReadAsLatin1(value: string): string {
    let high = false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code >= LATIN1_END) return value;
        if (code >= ASCII_END) high = true;
    }
    if (!high) return value;
    try {
        return utf8.decode(Uint8Array.from(value, c => c.charCodeAt(0)));
    } catch {
        return value;
    }
}
