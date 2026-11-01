import { useEffect, useRef } from 'react';

import { api } from '../api.ts';
import { useToast } from '../components/Toast.tsx';
import { WebhooksSection } from '../components/WebhooksSection.tsx';
import { useConfig } from '../config.tsx';
import {
    formatBytes,
    formatCount,
    formatDate,
    formatDateTime,
    formatRelative,
    hostOf
} from '../format.ts';
import { useApi } from '../useApi.ts';

export function SettingsPage() {
    const { dashOrigin, shortOrigin, version, reputation, abuseMinScore } = useConfig();
    const toast = useToast();
    const origin = dashOrigin || location.origin;
    const bookmarklet = `javascript:location.href='${origin}/links?new='+encodeURIComponent(location.href)`;
    const curl = `curl -X POST ${origin}/api/links \\
  -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com","slug":"optional"}'`;

    // React blocks javascript: URLs in href, so set it on the element directly.
    const bookmarkletRef = useRef<HTMLAnchorElement>(null);
    useEffect(() => {
        bookmarkletRef.current?.setAttribute('href', bookmarklet);
    }, [bookmarklet]);

    const copy = async (text: string, what: string) => {
        try {
            await navigator.clipboard.writeText(text);
            toast.show(`Copied ${what}`);
        } catch {
            toast.show('Clipboard is not available here');
        }
    };

    return (
        <main className="page prose">
            <h1 className="page-title">Settings</h1>

            <section>
                <h2>Shorten from any page</h2>
                <p>
                    Drag this to your bookmarks bar. Clicking it on any page opens this dashboard
                    with that page’s address ready to shorten.
                </p>
                <p>
                    <a
                        ref={bookmarkletRef}
                        className="button bookmarklet"
                        href="#bookmarklet"
                        onClick={e => e.preventDefault()}
                    >
                        Shorten with {hostOf(shortOrigin)}
                    </a>
                </p>
            </section>

            <section>
                <h2>Shorten from scripts and shortcuts</h2>
                <p>
                    Create a service token in Cloudflare Zero Trust (Access, Service credentials),
                    allow it in this app’s Access policy, then send it with every request. This
                    works from an iOS Shortcut using “Get contents of URL”.
                </p>
                <pre className="code">{curl}</pre>
                <button
                    type="button"
                    className="button small"
                    onClick={() => void copy(curl, 'command')}
                >
                    Copy command
                </button>
            </section>

            <WebhooksSection />

            <section>
                <h2>Abusive and datacenter IPs</h2>
                {reputation ? (
                    <p>
                        Every visitor IP is checked against AbuseIPDB. Clicks from IPs with an abuse
                        confidence of {abuseMinScore}% or more, or that AbuseIPDB lists as
                        datacenter or hosting addresses, are hidden unless you tick “Include abusive
                        IPs” or “Include datacenter IPs”. Lookups run in the background, so a new IP
                        can take a few seconds to be flagged.
                    </p>
                ) : (
                    <p>
                        Only datacenter IPs that are recognisable from their hostname are hidden
                        now. To hide IPs reported for abuse as well, and to catch datacenter IPs
                        much more reliably, create a free API key at{' '}
                        <a
                            href="https://www.abuseipdb.com/account/api"
                            target="_blank"
                            rel="noreferrer"
                        >
                            abuseipdb.com
                        </a>{' '}
                        and set <code>ABUSEIPDB_API_KEY</code>. Clicks from the last 30 days are
                        checked once it’s set, busiest IPs first, within the daily quota.
                    </p>
                )}
            </section>

            <section>
                <h2>VPNs and scrapers</h2>
                <p>
                    Clicks from Tor exits, iCloud Private Relay and Cloudflare WARP are marked as
                    VPN / relay from public address lists, refreshed daily. A hosting IP whose
                    visitor behaves like a person (it runs the device page with a local clock, or it
                    belongs to a VPN provider’s network) counts as VPN too. These are real people,
                    so they stay counted unless you untick “Include VPN / relay”.
                </p>
                <p>
                    Clicks that look automated without saying they’re bots are marked as scrapers
                    and hidden unless you tick “Include scrapers”. That covers clicks with no user
                    agent or Accept-Language header, browsers driven by automation or rendering
                    without a GPU, and, from hosting IPs, a UTC clock or skipping the device page.
                    The last two need device tracking on the link.
                </p>
            </section>

            <section>
                <h2>About</h2>
                <p>
                    Short links on <code>{shortOrigin}</code>, version {version}.
                </p>
                <AboutFacts />
            </section>

            <section>
                <h2>Export</h2>
                <p>
                    Download a copy of the whole SQLite database: links, clicks and webhooks. It
                    includes visitor IP addresses and webhook secrets, so keep it somewhere safe.
                </p>
                <p>
                    <a className="button" href="/api/export" download>
                        Download database
                    </a>
                </p>
            </section>
        </main>
    );
}

function AboutFacts() {
    const { data, error } = useApi('about', () => api.about());
    if (error) return <p className="muted">Couldn’t load server details: {error.message}</p>;
    if (!data) return <p className="muted">Loading…</p>;
    const db = data.database;

    return (
        <dl className="facts">
            <dt>Database size</dt>
            <dd>
                {formatBytes(db.sizeBytes)}
                {db.freeBytes > 0 && (
                    <span className="muted"> ({formatBytes(db.freeBytes)} unused)</span>
                )}
            </dd>
            <dt>Write-ahead log</dt>
            <dd>{formatBytes(db.walBytes)}</dd>
            <dt>Database file</dt>
            <dd>
                <code>{db.path || 'in memory'}</code>
            </dd>
            <dt>Links</dt>
            <dd>{formatCount(db.links)}</dd>
            <dt>Clicks</dt>
            <dd>
                {formatCount(db.clicks)}
                {db.firstClickAt !== null && (
                    <span className="muted"> since {formatDate(db.firstClickAt)}</span>
                )}
            </dd>
            <dt>Webhooks</dt>
            <dd>
                {formatCount(db.webhooks)}
                <span className="muted"> ({formatCount(db.webhookEvents)} events in the log)</span>
            </dd>
            <dt>Schema</dt>
            <dd>
                <code>{db.migration ?? 'none'}</code>
            </dd>
            <dt>Running since</dt>
            <dd title={formatDateTime(data.startedAt)}>{formatRelative(data.startedAt)}</dd>
            <dt>Runtime</dt>
            <dd>
                Bun {data.bunVersion}, SQLite {db.sqliteVersion}
            </dd>
        </dl>
    );
}
