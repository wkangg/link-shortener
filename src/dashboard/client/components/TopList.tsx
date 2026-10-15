import { useState } from 'react';

import type { TopRow } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { countryLabel, formatCount } from '../format.ts';
import { useApi } from '../useApi.ts';

export interface Tab {
    dim: string;
    label: string;
}

interface TopListProps {
    title: string;
    tabs: Tab[];
    /** Stats query params without `dim`. */
    params: URLSearchParams;
    refreshKey: string;
    onSelect: (dim: string, row: TopRow) => void;
    /** For `param`: clicking a key drills into its values instead of filtering. */
    drill?: boolean;
}

function rowLabel(dim: string, row: TopRow): string {
    if (dim === 'country' && row.value) return countryLabel(row.value);
    return row.label;
}

export function TopList({
    title,
    tabs,
    params,
    refreshKey,
    onSelect,
    drill = false
}: TopListProps) {
    const [tabIndex, setTabIndex] = useState(0);
    const [drillKey, setDrillKey] = useState<string | null>(null);
    const tab = tabs[tabIndex] ?? tabs[0];
    const dim = drillKey === null ? (tab?.dim ?? '') : `param:${drillKey}`;

    const query = new URLSearchParams(params);
    query.set('dim', dim);
    query.set('limit', '10');
    const { data, error } = useApi(`${refreshKey}|${query}`, () => api.top(query));
    const rows = data?.rows ?? [];
    const max = Math.max(1, ...rows.map(r => r.clicks));

    return (
        <section className="panel" aria-label={title}>
            <header className="panel-header">
                <h3>{drillKey === null ? title : `?${drillKey}=`}</h3>
                {drillKey === null ? (
                    tabs.length > 1 && (
                        <div className="tabs" role="tablist">
                            {tabs.map((t, i) => (
                                <button
                                    key={t.dim}
                                    type="button"
                                    role="tab"
                                    aria-selected={i === tabIndex}
                                    className="tab"
                                    onClick={() => setTabIndex(i)}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>
                    )
                ) : (
                    <button type="button" className="text-button" onClick={() => setDrillKey(null)}>
                        All params
                    </button>
                )}
            </header>
            {error && <p className="panel-empty">Couldn’t load: {error.message}</p>}
            {!error && rows.length === 0 && <p className="panel-empty">Nothing yet</p>}
            <ol className="top-rows">
                {rows.map(row => (
                    <li key={row.value ?? '∅'}>
                        <button
                            type="button"
                            className="top-row"
                            title={`${row.clicks} clicks, ${row.visitors} unique visitors`}
                            onClick={() => {
                                if (drill && drillKey === null && row.value) setDrillKey(row.value);
                                else onSelect(dim, row);
                            }}
                        >
                            <span
                                className="top-bar"
                                style={{ width: `${(row.clicks / max) * 100}%` }}
                            />
                            <span className="top-label">{rowLabel(dim, row)}</span>
                            <span className="top-count">{formatCount(row.clicks)}</span>
                        </button>
                    </li>
                ))}
            </ol>
        </section>
    );
}
