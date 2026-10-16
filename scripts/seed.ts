// Fills a database with sample links and ~6 weeks of realistic clicks.
// Usage: bun run seed [--clicks 5000]   (uses DB_PATH and SHORT_ORIGIN from the environment)
import { ClickClassifier } from '../src/analytics/classify.ts';
import { ClickBuffer } from '../src/analytics/clicks.ts';
import { loadConfig } from '../src/config.ts';
import { LinkRepo } from '../src/dashboard/links.ts';
import { openDatabase } from '../src/db/client.ts';
import type { RawClick } from '../src/shared/types.ts';

const total = Number(process.argv[process.argv.indexOf('--clicks') + 1]) || 5000;
const config = loadConfig();
const db = openDatabase(config.dbPath);
const repo = new LinkRepo(db, { invalidate: () => {} });

const LINKS = [
    { slug: 'gh', url: 'https://github.com/example', title: 'GitHub', tags: ['profile'] },
    { slug: 'cv', url: 'https://example.com/resume.pdf', title: 'Résumé', tags: ['profile'] },
    {
        slug: 'talk',
        url: 'https://example.com/slides/bun-sqlite',
        title: 'Talk slides',
        tags: ['talks']
    },
    {
        slug: 'side',
        url: 'https://github.com/example/side-project',
        title: 'Side project',
        tags: ['projects']
    },
    { slug: 'menu', url: 'https://example.com/restaurant/menu', title: 'Menu QR', tags: ['qr'] },
    {
        slug: 'nl-oct',
        url: 'https://example.com/newsletter/october',
        title: 'October newsletter',
        tags: ['newsletter']
    },
    { slug: 'blog', url: 'https://example.com/blog/fast-redirects', title: null, tags: [] },
    { slug: 'yt', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: null, tags: [] }
];

const UAS = [
    [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        30
    ],
    [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        25
    ],
    [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        15
    ],
    [
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
        15
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 6],
    [
        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        4
    ],
    ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 3],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 2]
] as const;
const REFERRERS = [
    ['', 40],
    ['https://t.co/x1', 14],
    ['https://www.reddit.com/r/programming', 10],
    ['https://news.ycombinator.com/', 8],
    ['https://www.linkedin.com/feed/', 8],
    ['android-app://com.slack/', 5],
    ['https://mail.google.com/', 5],
    ['https://www.google.com/', 6],
    ['https://some-blog.dev/post', 4]
] as const;
const PLACES = [
    ['CA', 'Ontario', 'Toronto', 30],
    ['CA', 'Quebec', 'Montreal', 8],
    ['CA', 'British Columbia', 'Vancouver', 6],
    ['US', 'California', 'San Francisco', 12],
    ['US', 'New York', 'New York', 12],
    ['GB', 'England', 'London', 8],
    ['DE', 'Berlin', 'Berlin', 6],
    ['JP', 'Tokyo', 'Tokyo', 4],
    ['BR', 'São Paulo', 'São Paulo', 3],
    ['IN', 'Karnataka', 'Bengaluru', 5]
] as const;
const QUERIES = [
    ['', 70],
    ['utm_source=newsletter&utm_medium=email&utm_campaign=october', 10],
    ['utm_source=mastodon&utm_medium=social', 5],
    ['ref=ig', 6],
    ['ref=bio&v=2', 4],
    ['utm_source=talk&utm_medium=slides&utm_content=last-slide', 5]
] as const;

function pick<T extends readonly unknown[]>(items: readonly T[]): T {
    let sum = 0;
    for (const item of items) sum += Number(item.at(-1));
    let roll = Math.random() * sum;
    for (const item of items) {
        roll -= Number(item.at(-1));
        if (roll <= 0) return item;
    }
    return items[0] as T;
}

const links = LINKS.map(l => repo.getBySlug(l.slug) ?? repo.create(l));
// Zipf-ish popularity: the first link gets the most clicks.
const weights = links.map((_, i) => 1 / (i + 1));
let weightSum = 0;
for (const w of weights) weightSum += w;
const buffer = new ClickBuffer(db, {
    shortHost: new URL(config.shortOrigin).hostname,
    salt: 'seed'
});
// 400 people, each with one device and one home city; popular ones click more.
const people = Array.from({ length: 400 }, (_, i) => ({
    ip: `10.0.${Math.floor(i / 250)}.${i % 250}`,
    ua: pick(UAS)[0],
    place: pick(PLACES)
}));
const now = Date.now();
const SPAN = 45 * 86_400_000;

for (let n = 0; n < total; n++) {
    let roll = Math.random() * weightSum;
    let link = links[0];
    for (const [i, w] of weights.entries()) {
        roll -= w;
        if (roll <= 0) {
            link = links[i];
            break;
        }
    }
    if (!link) continue;
    // Skew towards recent days, with a daily rhythm.
    const age = Math.random() ** 1.6 * SPAN;
    const ts = now - age;
    const person = people[Math.floor(Math.random() ** 2 * people.length)] ?? people[0];
    if (!person) continue;
    const [country, region, city] = person.place;
    const isMenu = link.slug === 'menu';
    const click: RawClick = {
        linkId: link.id,
        ts: Math.round(ts),
        url: link.url,
        ip: person.ip,
        ua: person.ua,
        referrer: isMenu ? '' : pick(REFERRERS)[0],
        country,
        region,
        city,
        qr: isMenu ? Math.random() < 0.9 : Math.random() < 0.04,
        query: link.slug === 'nl-oct' ? QUERIES[1][0] : pick(QUERIES)[0],
        language: 'en-US,en;q=0.9',
        timezone: '',
        token: null,
        latitude: '',
        longitude: ''
    };
    buffer.push(click);
}

const written = buffer.flush();

// Mark a slice of visitors as datacenter traffic (with a plausible hosting
// hostname) so the "Include datacenter IPs" toggle has something to hide.
const DC_HOSTS = [
    'compute.amazonaws.com',
    'googleusercontent.com',
    'clients.your-server.de',
    'vultrusercontent.com'
];
const markDc = db.query('UPDATE clicks SET is_datacenter = 1, hostname = ? WHERE ip = ?');
db.transaction(() => {
    people.forEach((person, i) => {
        if (i % 13 !== 0) return;
        const host = `host-${i}.${DC_HOSTS[i % DC_HOSTS.length]}`;
        markDc.run(host, person.ip);
    });
})();

// Some of the datacenter visitors are people on a VPN (a VPN provider's network, or
// a real browser with a local clock), and some visitors are scripts that send no
// Accept-Language header. The classifier sorts them out from those facts.
const markVpnHost = db.query("UPDATE clicks SET isp = 'M247 Europe SRL' WHERE ip = ?");
const markBrowser = db.query(
    "UPDATE clicks SET js = 1, timezone = 'Europe/Berlin', screen = '1920x1080@1' WHERE ip = ?"
);
const markScript = db.query('UPDATE clicks SET language = NULL WHERE ip = ?');
db.transaction(() => {
    people.forEach((person, i) => {
        if (i % 26 === 0) markVpnHost.run(person.ip);
        else if (i % 13 === 0 && i % 3 === 0) markBrowser.run(person.ip);
        else if (i % 17 === 0) markScript.run(person.ip);
    });
})();
new ClickClassifier(db).all();

console.log(`Seeded ${links.length} links and ${written} clicks into ${config.dbPath}`);
db.close();
