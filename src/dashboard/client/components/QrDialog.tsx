import { useState } from 'react';
import { renderSVG } from 'uqr';

import { Dialog } from './Dialog.tsx';
import { useToast } from './Toast.tsx';

type Ecc = 'L' | 'M' | 'Q' | 'H';

interface QrDialogProps {
    /** e.g. https://s.example/abc */
    shortUrl: string;
    slug: string;
    onClose: () => void;
}

/** The QR encodes `?qr` so scans show up as their own source in analytics. */
export const qrTarget = (shortUrl: string) => `${shortUrl}?qr`;

function svgFor(text: string, opts: { ecc: Ecc; fg: string; bg: string; margin: number }): string {
    return renderSVG(text, {
        ecc: opts.ecc,
        border: opts.margin,
        pixelSize: 10,
        blackColor: opts.fg,
        whiteColor: opts.bg
    });
}

const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function pngBlob(svg: string, size: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.addEventListener('load', () => {
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('Canvas is not available'));
                return;
            }
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, 0, 0, size, size);
            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('Could not render PNG'));
            }, 'image/png');
        });
        img.addEventListener('error', () => reject(new Error('Could not render QR image')));
        img.src = svgDataUrl(svg);
    });
}

function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function QrDialog({ shortUrl, slug, onClose }: QrDialogProps) {
    const toast = useToast();
    const [ecc, setEcc] = useState<Ecc>('M');
    const [size, setSize] = useState(1024);
    const [fg, setFg] = useState('#000000');
    const [bg, setBg] = useState('#ffffff');
    const [margin, setMargin] = useState(2);

    const target = qrTarget(shortUrl);
    const svg = svgFor(target, { ecc, fg, bg, margin });
    const name = `qr-${slug}`;

    const savePng = async () => download(await pngBlob(svg, size), `${name}.png`);
    const copyPng = async () => {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(svg, size) })]);
        toast.show('QR code copied');
    };
    const fail = (error: unknown) =>
        toast.show(error instanceof Error ? error.message : 'Something went wrong');

    return (
        <Dialog title={`QR code for /${slug}`} onClose={onClose}>
            <div className="qr-layout">
                <img
                    className="qr-preview"
                    src={svgDataUrl(svg)}
                    alt={`QR code that opens ${target}`}
                />
                <div className="qr-options">
                    <p className="qr-target">
                        Opens <code>{target}</code>
                    </p>
                    <label className="field">
                        <span>Error correction</span>
                        <select value={ecc} onChange={e => setEcc(e.target.value as Ecc)}>
                            <option value="L">Low (7%), smallest code</option>
                            <option value="M">Medium (15%)</option>
                            <option value="Q">Quartile (25%)</option>
                            <option value="H">High (30%), survives logos and damage</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>PNG size</span>
                        <select value={size} onChange={e => setSize(Number(e.target.value))}>
                            {[256, 512, 1024, 2048].map(px => (
                                <option key={px} value={px}>
                                    {px} × {px}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Quiet zone</span>
                        <input
                            type="range"
                            min={0}
                            max={6}
                            value={margin}
                            onChange={e => setMargin(Number(e.target.value))}
                        />
                    </label>
                    <div className="field-row">
                        <label className="field">
                            <span>Foreground</span>
                            <input type="color" value={fg} onChange={e => setFg(e.target.value)} />
                        </label>
                        <label className="field">
                            <span>Background</span>
                            <input type="color" value={bg} onChange={e => setBg(e.target.value)} />
                        </label>
                    </div>
                    <div className="button-row">
                        <button
                            type="button"
                            className="button primary"
                            onClick={() => void savePng().catch(fail)}
                        >
                            Download PNG
                        </button>
                        <button
                            type="button"
                            className="button"
                            onClick={() =>
                                download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`)
                            }
                        >
                            Download SVG
                        </button>
                        <button
                            type="button"
                            className="button"
                            onClick={() => void copyPng().catch(fail)}
                        >
                            Copy image
                        </button>
                    </div>
                </div>
            </div>
        </Dialog>
    );
}
