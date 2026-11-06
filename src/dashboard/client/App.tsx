import { type ReactNode, useEffect } from 'react';

import { api } from './api.ts';
import { ToastProvider } from './components/Toast.tsx';
import { ConfigContext } from './config.tsx';
import { hostOf, pageTitle } from './format.ts';
import { LinkPage } from './pages/LinkPage.tsx';
import { LinksPage } from './pages/LinksPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { linkClick, useLocation } from './router.ts';
import { useApi } from './useApi.ts';

const NAV = [
    { href: '/', label: 'Overview' },
    { href: '/links', label: 'Links' },
    { href: '/settings', label: 'Settings' }
];

function route(path: string): ReactNode {
    if (path === '/') return <OverviewPage />;
    if (path === '/links') return <LinksPage />;
    if (path === '/settings') return <SettingsPage />;
    const match = /^\/links\/(\d+)$/.exec(path);
    if (match) return <LinkPage key={match[1]} id={Number(match[1])} />;
    return (
        <main className="page">
            <p className="empty">There’s nothing at this address.</p>
        </main>
    );
}

export function App() {
    const { path } = useLocation();
    const config = useApi('config', () => api.config());
    const shortOrigin = config.data?.shortOrigin;

    // "Links · s.example". A link's own page swaps in its slug once it loads (LinkPage).
    useEffect(() => {
        if (!shortOrigin) return;
        const page = /^\/links\/\d+$/.test(path)
            ? 'Link'
            : (NAV.find(item => item.href === path)?.label ?? 'Not found');
        document.title = pageTitle(page, shortOrigin);
    }, [path, shortOrigin]);

    if (config.error) {
        return (
            <main className="page">
                <h1 className="page-title">Can’t reach the API</h1>
                <p className="error">{config.error.message}</p>
                <p>If you just signed in, reload the page.</p>
            </main>
        );
    }
    if (!config.data) return null;

    const current = path.startsWith('/links') ? '/links' : path;

    return (
        <ConfigContext value={config.data}>
            <ToastProvider>
                <header className="topbar">
                    <a className="wordmark" href="/" onClick={linkClick}>
                        {hostOf(config.data.shortOrigin)}
                    </a>
                    <nav aria-label="Main">
                        {NAV.map(item => (
                            <a
                                key={item.href}
                                href={item.href}
                                onClick={linkClick}
                                aria-current={current === item.href ? 'page' : undefined}
                            >
                                {item.label}
                            </a>
                        ))}
                    </nav>
                </header>
                {route(path)}
            </ToastProvider>
        </ConfigContext>
    );
}
