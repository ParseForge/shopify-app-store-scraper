import { Actor, log } from 'apify';
import c from 'chalk';
import * as cheerio from 'cheerio';

interface Input {
    maxItems?: number;
    keywordFilter?: string;
    appSlugs?: string[];
}

const STARTUP = ['🛍️ Pulling Shopify apps…', '🏪 Crawling app store…', '📦 Reading app catalog…'];
const DONE = ['🎉 Apps delivered.', '✅ Shopify catalog ready.', '🚀 App data captured.'];
const pick = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)] ?? arr[0]!;

await Actor.init();
const input = (await Actor.getInput<Input>()) ?? {};
const userIsPaying = Boolean(Actor.getEnv()?.userIsPaying);
const isPayPerEvent = Actor.getChargingManager().getPricingInfo().isPayPerEvent;

let effectiveMaxItems = input.maxItems ?? 10;
if (!userIsPaying) {
    if (!effectiveMaxItems || effectiveMaxItems > 10) {
        effectiveMaxItems = 10;
        log.warning([
            '',
            `${c.dim('        *  .  ✦        .    *       .')}`,
            `${c.dim('  .        *')}    🛰️  ${c.dim('.        *   .    ✦')}`,
            `${c.dim('     ✦  .        .       *        .')}`,
            '',
            `${c.yellow("  You're on a free plan — limited to 10 items.")}`,
            `${c.cyan('  Upgrade to a paid plan for up to 1,000,000 items.')}`,
            '',
            `  ✦ ${c.green.underline('https://console.apify.com/sign-up?fpr=vmoqkp')}`,
            '',
        ].join('\n'));
    }
}

const keyword = (input.keywordFilter ?? '').trim().toLowerCase();
const directSlugs = input.appSlugs ?? [];

console.log(c.cyan('\n🛰️  Arguments:'));
if (keyword) console.log(c.green(`   🟩 keywordFilter : ${keyword}`));
if (directSlugs.length) console.log(c.green(`   🟩 appSlugs : ${directSlugs.length} provided`));
console.log(c.green(`   🟩 maxItems : ${effectiveMaxItems}`));
console.log('');
console.log(c.magenta(`📬 ${pick(STARTUP)}\n`));

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
};

async function listSlugs(): Promise<string[]> {
    log.info('📡 Loading sitemap…');
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const r = await fetch('https://apps.shopify.com/sitemap.xml', {
                headers: {
                    ...HEADERS,
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                },
            });
            if (!r.ok) {
                log.warning(`   sitemap HTTP ${r.status} (attempt ${attempt}/4)`);
                await new Promise((res) => setTimeout(res, 1500 * attempt));
                continue;
            }
            const xml = await r.text();
            if (xml.length < 1000) {
                log.warning(`   sitemap thin response ${xml.length}B (attempt ${attempt}/4)`);
                await new Promise((res) => setTimeout(res, 1500 * attempt));
                continue;
            }
            const slugs: string[] = [];
            const re = /<loc>https:\/\/apps\.shopify\.com\/([a-z0-9_-]+)<\/loc>/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(xml)) !== null) {
                const slug = m[1]!;
                if (slug === 'sitemap' || slug === 'instant-search' || slug === 'partners' || slug === 'support') continue;
                slugs.push(slug);
            }
            return slugs;
        } catch (err: any) {
            log.warning(`   sitemap fetch error: ${err.message} (attempt ${attempt}/4)`);
            await new Promise((res) => setTimeout(res, 1500 * attempt));
        }
    }
    return [];
}

async function fetchApp(slug: string): Promise<Record<string, unknown> | null> {
    const url = `https://apps.shopify.com/${slug}`;
    try {
        const r = await fetch(url, { headers: HEADERS });
        if (!r.ok) return null;
        const html = await r.text();
        const $ = cheerio.load(html);

        let ld: any = null;
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const j = JSON.parse($(el).text());
                if (j['@type'] === 'SoftwareApplication') ld = j;
            } catch {}
        });

        const title = $('h1').first().text().trim() || ld?.name || null;
        const developer = $('a[href*="/partners/"]').first().text().trim() || ld?.brand || null;
        const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || null;
        const iconUrl = (Array.isArray(ld?.image) ? ld.image[0] : ld?.image) || $('meta[property="og:image"]').attr('content') || null;
        const category = ld?.applicationCategory || null;

        const rating = ld?.aggregateRating?.ratingValue ?? null;
        const ratingCount = ld?.aggregateRating?.ratingCount ?? null;

        const screenshots: string[] = [];
        $('img[src*="cdn.shopify.com/app-store"]').each((_, el) => {
            const s = $(el).attr('src');
            if (s && !screenshots.includes(s) && s !== iconUrl) screenshots.push(s);
        });

        return {
            iconUrl,
            appName: title,
            slug,
            url,
            developer,
            category,
            rating: typeof rating === 'number' ? rating : (rating ? Number(rating) : null),
            ratingCount: typeof ratingCount === 'number' ? ratingCount : (ratingCount ? Number(ratingCount) : null),
            description,
            screenshots: screenshots.slice(0, 12),
        };
    } catch (err: any) {
        log.warning(`   ${slug}: ${err.message}`);
        return null;
    }
}

let candidateSlugs: string[] = [];
if (directSlugs.length > 0) {
    candidateSlugs = directSlugs;
} else {
    const all = await listSlugs();
    log.info(`   ${all.length} slugs in sitemap`);
    candidateSlugs = keyword ? all.filter((s) => s.toLowerCase().includes(keyword)) : all;
    log.info(`   ${candidateSlugs.length} match keyword`);
}

let pushed = 0;
const overfetchCap = Math.min(candidateSlugs.length, effectiveMaxItems * 3);
const slugsToFetch = candidateSlugs.slice(0, overfetchCap);
const CONCURRENCY = 12;
const results: Array<Record<string, unknown> | null> = new Array(slugsToFetch.length).fill(null);
let cursor = 0;
let validCount = 0;
async function appWorker() {
    while (cursor < slugsToFetch.length && validCount < effectiveMaxItems) {
        const i = cursor++;
        const rec = await fetchApp(slugsToFetch[i]!);
        results[i] = rec;
        if (rec) validCount += 1;
    }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => appWorker()));
for (const rec of results) {
    if (pushed >= effectiveMaxItems) break;
    if (rec) {
        const item = { ...rec, scrapedAt: new Date().toISOString() };
        if (isPayPerEvent) await Actor.pushData([item], 'result-item');
        else await Actor.pushData([item]);
        pushed += 1;
    }
}

if (pushed === 0) await Actor.pushData([{ error: 'No Shopify apps matched.' }]);
log.info(c.green(`✅ Pushed ${pushed} apps`));
console.log(c.magenta(`\n${pick(DONE)}`));
await Actor.exit();
