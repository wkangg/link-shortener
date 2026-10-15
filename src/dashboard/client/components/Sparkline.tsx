/** Seven-day click sparkline. Decorative: the click count next to it carries the number. */
export function Sparkline({ values }: { values: number[] }) {
    const max = Math.max(1, ...values);
    const w = 70;
    const h = 20;
    const step = w / Math.max(1, values.length - 1);
    const points = values
        .map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`)
        .join(' ');
    return (
        <svg
            className="sparkline"
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            aria-hidden="true"
        >
            <polyline points={points} fill="none" />
        </svg>
    );
}
