import { useEffect, useRef } from 'react';

import { useToast } from '../components/Toast.tsx';
import { useConfig } from '../config.tsx';
import { hostOf } from '../format.ts';

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
                <h2>About</h2>
                <p>
                    Short links on <code>{shortOrigin}</code>, version {version}.
                </p>
            </section>
        </main>
    );
}
