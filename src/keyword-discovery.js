#!/usr/bin/env node
/**
 * keyword-discovery.js: Ahrefs-powered automated keyword discovery
 *
 * Pulls long-tail keyword opportunities from the Ahrefs REST API v3, scores
 * them by opportunity (traffic potential against difficulty), deduplicates
 * against the existing Google Sheet queue, and appends new pending keywords
 * to the right tab. Runs unattended from a seed list.
 *
 * ARCHITECTURE
 * 1. Reads seed topics from config/discovery.json (or the --topics CLI arg)
 * 2. For each seed, calls two Ahrefs endpoints in parallel:
 *    - keywords-explorer/matching-terms      (phrase matches)
 *    - keywords-explorer/search-suggestions  (autocomplete-style)
 * 3. Adds a competitor gap scan and a trending scan
 * 4. Merges, deduplicates, filters and scores the results
 * 5. Cross-references against keywords already in the Sheet
 * 6. Pushes new opportunities to the Sheet and emails a report
 *
 * USAGE
 *   node src/keyword-discovery.js                    full discovery + push to Sheet
 *   node src/keyword-discovery.js --dry-run          discover only, print to console
 *   node src/keyword-discovery.js --report           list the configured seed topics
 *   node src/keyword-discovery.js --topics "a,b"     override seeds
 *   node src/keyword-discovery.js --max-per-seed 30  limit results per seed (default 50)
 *
 * REQUIRED ENV VARS
 *   AHREFS_API_TOKEN             Ahrefs API v3 bearer token
 *   BLOG_SHEET_ID                Google Sheet ID for the content queue
 *   GOOGLE_SERVICE_ACCOUNT_PATH  path to service-account.json
 *
 * OPTIONAL ENV VARS
 *   SITE_DOMAIN                  your domain, for the competitor gap scan
 *   GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_NOTIFY   discovery report email
 *   COMPANY_NAME, CONFIG_DIR, SHEET_TAB_COMMERCIAL, SHEET_TAB_INFORMATIONAL, SHEET_TAB_WHOLESALE
 */

require('dotenv').config({ quiet: true });
const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const AHREFS_TOKEN = process.env.AHREFS_API_TOKEN || '';
const AHREFS_BASE  = 'https://api.ahrefs.com/v3';
const SA_PATH      = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || path.resolve(__dirname, '..', 'service-account.json');
const SHEET_ID     = process.env.BLOG_SHEET_ID || '';
const SITE_URL     = process.env.SITE_DOMAIN || '';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Keyword Discovery';
const EMAIL_NOTIFY = process.env.EMAIL_NOTIFY || process.env.GMAIL_USER || '';
const GMAIL_USER   = process.env.GMAIL_USER || '';
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD || '';

const COMMERCIAL_TAB  = process.env.SHEET_TAB_COMMERCIAL || 'Commercial';
const INFO_TAB        = process.env.SHEET_TAB_INFORMATIONAL || 'Informational';
const WHOLESALE_TAB   = process.env.SHEET_TAB_WHOLESALE || 'Wholesale';

// CLI
const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const REPORT   = args.includes('--report');
const MAX_PER_SEED = (() => {
  const i = args.indexOf('--max-per-seed');
  return i >= 0 ? parseInt(args[i + 1], 10) : 50;
})();

// ─────────────────────────────────────────────────────────────
// Configuration: seeds, competitors and word lists live in config/discovery.json
// (falls back to the example file). Each seed: { topic, market, intent }
//   topic:  the seed phrase to expand via Ahrefs
//   market: Ahrefs country code ('us', 'gb', 'de', ...)
//   intent: 'informational' or 'commercial', the default Sheet tab
// Word lists are regex fragments, joined into one word-bounded pattern.
// ─────────────────────────────────────────────────────────────
const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(__dirname, '..', 'config');
function loadConfig() {
  for (const f of ['discovery.json', 'discovery.example.json']) {
    const p = path.join(CONFIG_DIR, f);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('Missing config/discovery.json');
}
const CONFIG = loadConfig();
const NEVER  = /(?!)/; // matches nothing: an empty list disables that rule
function toPattern(terms) {
  return terms && terms.length ? new RegExp(`\\b(${terms.join('|')})\\b`, 'i') : NEVER;
}

const HOME_MARKET   = CONFIG.homeMarket || 'us';
const SEED_TOPICS   = CONFIG.seeds || [];
const COMPETITORS   = CONFIG.competitors || [];
const TRENDING_SEEDS = CONFIG.trendingSeeds || [];

const BRAND_PATTERN       = toPattern(CONFIG.brandTerms);
const IRRELEVANT_PATTERN  = toPattern(CONFIG.irrelevantTerms);
const RELEVANCE_PATTERN   = CONFIG.relevanceTerms && CONFIG.relevanceTerms.length ? toPattern(CONFIG.relevanceTerms) : /./;
// Retired topics: dropped unless the keyword also carries an exception angle
const RETIRED_PATTERN     = toPattern(CONFIG.retiredTerms);
const EXCEPTION_PATTERN   = toPattern(CONFIG.retiredExceptionTerms);

const INTENT = CONFIG.intent || {};
const INTL_LANGUAGE_PATTERN = toPattern(INTENT.internationalLanguageTerms);
const INTL_GEO_PATTERN      = toPattern(INTENT.internationalGeoTerms);
const INFO_PATTERN          = toPattern(INTENT.informationalTerms);
const B2B_PATTERN           = toPattern(INTENT.b2bTerms);
const BUYING_PATTERN        = toPattern(INTENT.buyingTerms);

// ─────────────────────────────────────────────────────────────
// Ahrefs API client
// ─────────────────────────────────────────────────────────────

/**
 * Calls an Ahrefs v3 endpoint.
 * @param {string} endpoint - e.g. 'keywords-explorer/matching-terms'
 * @param {object} params   - query params (select, country, keywords, where, order_by, limit)
 * @returns {object} parsed JSON response
 */
async function ahrefsCall(endpoint, params) {
  const url = new URL(`${AHREFS_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }

  const resp = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${AHREFS_TOKEN}`,
      'Accept': 'application/json',
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Ahrefs ${endpoint} HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  return resp.json();
}

// Standard filter: low KD, reasonable volume, long-tail
function buildFilter({ minVol = 10, maxVol = 5000, maxKD = 20 } = {}) {
  return {
    and: [
      { field: 'volume', is: ['gte', minVol] },
      { field: 'volume', is: ['lte', maxVol] },
      { field: 'difficulty', is: ['lte', maxKD] },
    ],
  };
}

/**
 * Discover keywords for a single seed topic.
 * Calls two Ahrefs endpoints in parallel and merges results.
 */
async function discoverForSeed(seed) {
  const baseParams = {
    select: 'keyword,volume,difficulty,traffic_potential,cpc,global_volume',
    country: seed.market,
    keywords: seed.topic,
    where: buildFilter(),
    order_by: 'traffic_potential:desc',
    limit: seed.limit || MAX_PER_SEED,
  };

  const [matching, suggestions] = await Promise.allSettled([
      ahrefsCall('keywords-explorer/matching-terms', baseParams),
      ahrefsCall('keywords-explorer/search-suggestions', {
        ...baseParams,
        select: 'keyword,volume,difficulty,traffic_potential,cpc',
      }),
    ]);

  // Log any failures for debugging
  const failures = [matching, suggestions].filter(r => r.status === 'rejected');
  if (failures.length === 2) {
    const reason = failures[0].reason?.message || 'unknown';
    console.warn(`       ⚠️  Both API calls failed: ${reason.slice(0, 100)}`);
  }

  // Merge all results, deduplicate by keyword
  const seen = new Map(); // keyword → best row
  for (const result of [matching, suggestions]) {
    const data = result.status === 'fulfilled' ? result.value : {};
    const kws = data.keywords || [];
    for (const kw of kws) {
      const key = kw.keyword.toLowerCase().trim();
      // Keep the one with higher traffic_potential
      if (!seen.has(key) || (kw.traffic_potential || 0) > (seen.get(key).traffic_potential || 0)) {
        seen.set(key, { ...kw, seedTopic: seed.topic, market: seed.market, intent: seed.intent });
      }
    }
  }

  return Array.from(seen.values());
}

// ─────────────────────────────────────────────────────────────
// Scoring and filtering
// ─────────────────────────────────────────────────────────────

/**
 * Score a keyword by opportunity.
 * Higher is better: high traffic potential + low difficulty = best opportunities.
 */
function scoreKeyword(kw) {
  const tp = kw.traffic_potential || kw.volume || 1;
  const kd = kw.difficulty || 0;
  // log10(TP) × 10 − (KD / 5)  : penalize difficulty more heavily
  return Math.round((Math.log10(tp + 1) * 10 - kd / 5) * 10) / 10;
}

/**
 * Filter out branded keywords, irrelevant terms, and very short phrases.
 */
function filterKeywords(keywords) {
  return keywords.filter(kw => {
    const keyword = kw.keyword.toLowerCase();
    const wordCount = keyword.split(/\s+/).length;

    // Must be at least 2 words; 2-word keywords need higher traffic potential
    if (wordCount < 2) return false;
    if (wordCount === 2 && (kw.traffic_potential || 0) < 100) return false;

    // No competitor brand names
    if (BRAND_PATTERN.test(keyword)) return false;

    // No off-topic or unwanted terms
    if (IRRELEVANT_PATTERN.test(keyword)) return false;

    // No new content for retired topics, unless the keyword has an exception angle
    if (RETIRED_PATTERN.test(keyword) && !EXCEPTION_PATTERN.test(keyword)) return false;

    // Must contain at least one relevance signal for the business
    if (!RELEVANCE_PATTERN.test(keyword)) return false;

    // Must have meaningful traffic potential
    if ((kw.traffic_potential || 0) < 20) return false;

    return true;
  });
}

/**
 * Route a keyword to a Sheet tab: 'wholesale' (all international content),
 * 'commercial' or 'informational'.
 */
function classifyIntent(keyword, seedIntent, seedMarket = HOME_MARKET) {
  const kw = keyword.toLowerCase();

  // Seed market is authoritative: anything discovered from a non-home market seed
  // goes to the international tab, even if the keyword text has no language or geo marker.
  if (seedMarket && seedMarket !== HOME_MARKET) return 'wholesale';

  // Local-language trade terms and geo mentions also route to the international tab
  if (INTL_LANGUAGE_PATTERN.test(kw)) return 'wholesale';
  if (INTL_GEO_PATTERN.test(kw)) return 'wholesale';

  // Question-type topics are informational even when they contain buying words
  if (INFO_PATTERN.test(kw)) return 'informational';

  // Home-market B2B and buying signals are commercial
  if (B2B_PATTERN.test(kw)) return 'commercial';
  if (BUYING_PATTERN.test(kw)) return 'commercial';

  // Default to the seed topic's intent
  return seedIntent || 'informational';
}

/**
 * Generate a contextual note for the keyword based on its metrics.
 */
function generateNote(kw) {
  const parts = [];

  // Source: tag where this keyword came from
  if (kw.source === 'competitor_gap') {
    parts.push(`🕵️ COMPETITOR GAP: they rank, we don't. From ${kw.seedTopic}`);
  } else if (kw.source === 'trending_scan') {
    parts.push(`📈 TRENDING: rising search query. From ${kw.seedTopic}`);
  } else {
    parts.push(`Ahrefs auto-discovery from "${kw.seedTopic}"`);
  }

  // Opportunity callout
  if (kw.difficulty <= 5 && (kw.traffic_potential || 0) >= 5000) {
    parts.push('🎯 HIGH PRIORITY: Low KD + high TP');
  } else if (kw.difficulty === 0) {
    parts.push('KD 0: zero competition');
  } else if (kw.difficulty <= 10) {
    parts.push('Very low KD: easy win');
  }

  // Metrics
  parts.push(`Vol:${kw.volume} KD:${kw.difficulty} TP:${kw.traffic_potential || 'N/A'}`);

  // Market
  const marketLabels = {
    gb: 'UK', uk: 'UK', fr: 'France', de: 'Germany', es: 'Spain', it: 'Italy',
    nl: 'Netherlands', pl: 'Poland', cz: 'Czech Republic', at: 'Austria',
  };
  if (kw.market && kw.market !== HOME_MARKET) {
    parts.push(`${marketLabels[kw.market] || kw.market.toUpperCase()} market`);
  }

  return parts.join('. ');
}

// ─────────────────────────────────────────────────────────────
// COMPETITOR GAP SCAN: find keywords competitors rank for that we don't
// ─────────────────────────────────────────────────────────────

/**
 * Pull competitor organic keywords and find opportunities.
 * Filters for keywords relevant to the business, low to mid KD, that we don't rank for.
 */
async function competitorGapScan() {
  if (!AHREFS_TOKEN || !SITE_URL || !COMPETITORS.length) return [];

  console.log('\n  🕵️  Running competitor gap scan...');
  const gapKeywords = [];

  // Our own organic keywords, fetched once for comparison
  let ourKeywords = new Set();
  try {
    const ourResp = await ahrefsCall('site-explorer/organic-keywords', {
      select: 'keyword',
      target: SITE_URL,
      country: HOME_MARKET,
      limit: 500,
    });
    ourKeywords = new Set((ourResp.keywords || []).map(k => k.keyword.toLowerCase().trim()));
  } catch (err) {
    console.warn(`    ⚠️  Could not load own keywords, skipping gap scan: ${err.message}`);
    return [];
  }

  for (const competitor of COMPETITORS) {
    try {
      // Pull competitor's top organic keywords (low-mid KD, decent traffic)
      const resp = await ahrefsCall('site-explorer/organic-keywords', {
        select: 'keyword,volume,best_position,sum_traffic,keyword_difficulty',
        target: competitor,
        country: HOME_MARKET,
        order_by: 'sum_traffic:desc',
        limit: 100,
        where: JSON.stringify({
          and: [
            { field: 'keyword_difficulty', is: ['lte', 40] },
            { field: 'volume', is: ['gte', 50] },
            { field: 'best_position', is: ['lte', 20] },
          ],
        }),
      });

      const keywords = resp.keywords || [];
      console.log(`    ${competitor}: ${keywords.length} keywords found (KD ≤ 40, Vol ≥ 50)`);

      for (const kw of keywords) {
        const keyword = kw.keyword.toLowerCase().trim();

        // Skip if we already rank for it
        if (ourKeywords.has(keyword)) continue;

        // Must be relevant, not a retired topic, and not a brand term
        if (!RELEVANCE_PATTERN.test(keyword)) continue;
        if (RETIRED_PATTERN.test(keyword) && !EXCEPTION_PATTERN.test(keyword)) continue;
        if (BRAND_PATTERN.test(keyword)) continue;

        gapKeywords.push({
          keyword: kw.keyword,
          volume: kw.volume,
          difficulty: kw.keyword_difficulty || 0,
          traffic_potential: kw.sum_traffic || kw.volume,
          market: HOME_MARKET,
          intent: 'commercial',
          seedTopic: `competitor-gap:${competitor}`,
          source: 'competitor_gap',
        });
      }

      console.log(`    → ${gapKeywords.length} gap opportunities (they rank, we don't)`);
    } catch (err) {
      console.warn(`    ⚠️  Gap scan failed for ${competitor}: ${err.message}`);
    }
  }

  return gapKeywords;
}

// ─────────────────────────────────────────────────────────────
// TRENDING KEYWORD DETECTION: spot rising opportunities
// ─────────────────────────────────────────────────────────────

/**
 * Re-scans a short list of core terms through Ahrefs search-suggestions with
 * relaxed filters, to catch new variations as they start to get searched.
 */
async function trendingScan() {
  if (!AHREFS_TOKEN) return [];

  console.log('\n  📈  Running trending keyword scan...');

  // Core terms from config, scanned for new long-tail variations with a relaxed volume filter
  const trendingSeeds = TRENDING_SEEDS;

  const trendingKeywords = [];

  for (const seed of trendingSeeds) {
    try {
      // Use search-suggestions which picks up trending/autocomplete queries
      const resp = await ahrefsCall('keywords-explorer/search-suggestions', {
        select: 'keyword,volume,difficulty,traffic_potential',
        country: HOME_MARKET,
        keywords: seed,
        order_by: 'traffic_potential:desc',
        limit: 20,
        where: JSON.stringify({
          and: [
            { field: 'difficulty', is: ['lte', 25] },
            { field: 'volume', is: ['gte', 20] },
          ],
        }),
      });

      const keywords = (resp.keywords || []).map(kw => ({
        ...kw,
        market: HOME_MARKET,
        intent: 'informational',
        seedTopic: `trending:${seed}`,
        source: 'trending_scan',
      }));

      trendingKeywords.push(...keywords);
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.warn(`    ⚠️  Trending scan failed for "${seed}": ${err.message}`);
    }
  }

  console.log(`    → ${trendingKeywords.length} trending candidates found`);
  return trendingKeywords;
}

// ─────────────────────────────────────────────────────────────
// Google Sheets integration
// ─────────────────────────────────────────────────────────────

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(SA_PATH),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

/**
 * Get all existing keywords from all three Sheet tabs (for dedup).
 * Returns a Set of lowercase keyword strings.
 */
async function getExistingKeywords(sheets) {
  const existing = new Set();
  for (const tab of [COMMERCIAL_TAB, INFO_TAB, WHOLESALE_TAB]) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A2:A`,
      });
      for (const row of (res.data.values || [])) {
        const kw = (row[0] || '').toLowerCase().trim();
        if (kw) existing.add(kw);
      }
    } catch (err) {
      console.warn(`  ⚠️  Could not read ${tab} tab: ${err.message}`);
    }
  }
  return existing;
}

/**
 * Push new keywords to the Google Sheet in batch.
 */
async function pushToSheet(sheets, keywords) {
  const wholesaleRows = [];
  const commercialRows = [];
  const infoRows = [];

  for (const kw of keywords) {
    const intent = classifyIntent(kw.keyword, kw.intent, kw.market);
    const note = generateNote(kw);
    // Columns: A=Keyword, B=Status, C=Notes, D=Format, E=URL, F=Date, G=Error
    const row = [kw.keyword, 'pending', note, '', '', '', ''];

    if (intent === 'wholesale') {
      wholesaleRows.push(row);
    } else if (intent === 'commercial') {
      commercialRows.push(row);
    } else {
      infoRows.push(row);
    }
  }

  let totalAdded = 0;

  if (wholesaleRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${WHOLESALE_TAB}!A2`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: wholesaleRows },
    });
    totalAdded += wholesaleRows.length;
  }

  if (commercialRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${COMMERCIAL_TAB}!A2`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: commercialRows },
    });
    totalAdded += commercialRows.length;
  }

  if (infoRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${INFO_TAB}!A2`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: infoRows },
    });
    totalAdded += infoRows.length;
  }

  return {
    wholesale: wholesaleRows.length,
    commercial: commercialRows.length,
    informational: infoRows.length,
    total: totalAdded,
  };
}

// ─────────────────────────────────────────────────────────────
// Email report
// ─────────────────────────────────────────────────────────────
async function sendDiscoveryReport(results) {
  if (!GMAIL_USER || !GMAIL_PASS) return;

  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });

    const top10 = results.added.slice(0, 10).map((kw, i) =>
      `${i + 1}. "${kw.keyword}": Vol:${kw.volume} KD:${kw.difficulty} TP:${kw.traffic_potential} (score: ${scoreKeyword(kw)})`
    ).join('\n');

    const html = `
      <h2>🔍 Keyword Discovery Report</h2>
      <p><strong>Date:</strong> ${new Date().toISOString().split('T')[0]}</p>
      <p><strong>Seeds scanned:</strong> ${results.seedsScanned}</p>
      <p><strong>Raw candidates:</strong> ${results.rawCount}</p>
      <p><strong>After filtering:</strong> ${results.filteredCount}</p>
      <p><strong>Already in Sheet:</strong> ${results.duplicateCount}</p>
      <p><strong>New keywords added:</strong> ${results.added.length}</p>
      <p style="margin-left:20px">Wholesale tab: ${results.wholesaleCount}<br>Commercial tab: ${results.commercialCount}<br>Informational tab: ${results.informationalCount}</p>
      <p><strong>Sources:</strong></p>
      <p style="margin-left:20px">Seed discovery: ${results.added.filter(k => !k.source).length}<br>Competitor gaps: ${results.added.filter(k => k.source === 'competitor_gap').length}<br>Trending scan: ${results.added.filter(k => k.source === 'trending_scan').length}</p>
      <h3>Top 10 new opportunities:</h3>
      <pre>${top10 || '(none)'}</pre>
      <p style="color:#888;font-size:12px">Generated by keyword-discovery.js, Ahrefs API v3</p>
    `;

    await transport.sendMail({
      from: GMAIL_USER,
      to: EMAIL_NOTIFY,
      subject: `[${COMPANY_NAME}] Keyword discovery: ${results.added.length} new keywords added`,
      html,
    });
    console.log('  📧  Discovery report emailed');
  } catch (err) {
    console.warn(`  ⚠️  Email failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Exportable function for a content pipeline
// ─────────────────────────────────────────────────────────────

/**
 * Run keyword discovery and push to Sheet.
 * Can be called from a content pipeline when its keyword queue runs dry.
 * @param {object} sheets - Google Sheets client (optional; creates one if not provided)
 * @param {object} opts   - { dryRun, maxPerSeed, seeds }
 * @returns {number} count of new keywords added
 */
async function runDiscovery(sheets, opts = {}) {
  const dryRun     = opts.dryRun ?? DRY_RUN;
  const maxPerSeed = opts.maxPerSeed ?? MAX_PER_SEED;
  const seeds      = opts.seeds ?? SEED_TOPICS;

  if (!AHREFS_TOKEN) {
    console.log('  ⚠️  No AHREFS_API_TOKEN: cannot run keyword discovery');
    return 0;
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  AHREFS KEYWORD DISCOVERY');
  console.log('  Seeds: ' + seeds.length + ' topics | Max per seed: ' + maxPerSeed);
  console.log('═'.repeat(60) + '\n');

  // 1. Discover keywords for all seed topics
  const allDiscovered = [];
  let seedsScanned = 0;

  for (const seed of seeds) {
    try {
      console.log(`  🔍  Scanning: "${seed.topic}" (${seed.market.toUpperCase()})...`);
      const results = await discoverForSeed({ ...seed, limit: maxPerSeed });
      allDiscovered.push(...results);
      seedsScanned++;
      console.log(`       → ${results.length} raw keywords`);

      // Rate limit: small delay between seeds to avoid hitting Ahrefs rate limits
      if (seedsScanned < seeds.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.warn(`  ⚠️  Failed for "${seed.topic}": ${err.message}`);
    }
  }

  console.log(`\n  📊  Raw discovered: ${allDiscovered.length} keywords from ${seedsScanned} seeds`);

  // 1b. Competitor gap scan: find keywords competitors rank for that we don't
  try {
    const gapKeywords = await competitorGapScan();
    if (gapKeywords.length > 0) {
      allDiscovered.push(...gapKeywords);
      console.log(`  📊  + ${gapKeywords.length} competitor gap keywords added`);
    }
  } catch (err) {
    console.warn(`  ⚠️  Competitor gap scan failed: ${err.message}`);
  }

  // 1c. Trending keyword scan: catch rising queries
  try {
    const trendingKeywords = await trendingScan();
    if (trendingKeywords.length > 0) {
      allDiscovered.push(...trendingKeywords);
      console.log(`  📊  + ${trendingKeywords.length} trending keywords added`);
    }
  } catch (err) {
    console.warn(`  ⚠️  Trending scan failed: ${err.message}`);
  }

  // 2. Deduplicate within discovered set
  const deduped = new Map();
  for (const kw of allDiscovered) {
    const key = kw.keyword.toLowerCase().trim();
    if (!deduped.has(key) || (kw.traffic_potential || 0) > (deduped.get(key).traffic_potential || 0)) {
      deduped.set(key, kw);
    }
  }
  console.log(`  📊  After internal dedup: ${deduped.size} unique keywords`);

  // 3. Filter for quality long-tail keywords
  const filtered = filterKeywords(Array.from(deduped.values()));
  console.log(`  📊  After quality filter: ${filtered.length} keywords`);

  // 4. Score and sort
  const scored = filtered.sort((a, b) => scoreKeyword(b) - scoreKeyword(a));

  // 5. Deduplicate against existing Google Sheet keywords
  let existingKeywords = new Set();
  if (!dryRun && SHEET_ID) {
    if (!sheets) sheets = await getSheetsClient();
    existingKeywords = await getExistingKeywords(sheets);
    console.log(`  📊  Existing keywords in Sheet: ${existingKeywords.size}`);
  }

  const genuinelyNew = scored.filter(kw => !existingKeywords.has(kw.keyword.toLowerCase().trim()));
  const duplicateCount = scored.length - genuinelyNew.length;
  console.log(`  📊  Already in Sheet: ${duplicateCount} | Genuinely new: ${genuinelyNew.length}`);

  if (genuinelyNew.length === 0) {
    console.log('\n  ✅  No new keyword opportunities found. All candidates already in queue.');
    return 0;
  }

  // 6. Print top opportunities
  console.log('\n  🏆  Top 15 new opportunities:');
  console.log('  ' + '─'.repeat(76));
  console.log(`  ${'Keyword'.padEnd(45)} ${'Vol'.padStart(5)} ${'KD'.padStart(3)} ${'TP'.padStart(7)} ${'Score'.padStart(6)}`);
  console.log('  ' + '─'.repeat(76));
  genuinelyNew.slice(0, 15).forEach(kw => {
    console.log(`  ${kw.keyword.slice(0, 43).padEnd(45)} ${String(kw.volume).padStart(5)} ${String(kw.difficulty).padStart(3)} ${String(kw.traffic_potential || 0).padStart(7)} ${String(scoreKeyword(kw)).padStart(6)}`);
  });
  console.log('  ' + '─'.repeat(76));

  // 7. Push to Sheet (unless dry run)
  if (dryRun) {
    console.log(`\n  🚫  DRY RUN: would add ${genuinelyNew.length} keywords to Sheet\n`);
    return genuinelyNew.length;
  }

  if (!SHEET_ID) {
    console.error('  ❌  BLOG_SHEET_ID not set: cannot push to Sheet');
    return 0;
  }

  if (!sheets) sheets = await getSheetsClient();
  const counts = await pushToSheet(sheets, genuinelyNew);
  console.log(`\n  ✅  Added ${counts.total} new keywords to Google Sheet:`);
  console.log(`     Wholesale tab:     ${counts.wholesale}`);
  console.log(`     Commercial tab:    ${counts.commercial}`);
  console.log(`     Informational tab: ${counts.informational}`);

  // 8. Send email report
  await sendDiscoveryReport({
    seedsScanned,
    rawCount: allDiscovered.length,
    filteredCount: filtered.length,
    duplicateCount,
    added: genuinelyNew,
    wholesaleCount: counts.wholesale,
    commercialCount: counts.commercial,
    informationalCount: counts.informational,
  });

  console.log('\n  ✅  Keyword discovery complete!\n');
  return counts.total;
}

module.exports = { runDiscovery, SEED_TOPICS, scoreKeyword, filterKeywords, classifyIntent, generateNote };

// ─────────────────────────────────────────────────────────────
// CLI entrypoint
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  // Parse --topics override
  const topicsIdx = args.indexOf('--topics');
  let seeds = SEED_TOPICS;
  if (topicsIdx >= 0 && args[topicsIdx + 1]) {
    seeds = args[topicsIdx + 1].split(',').map(t => ({
      topic: t.trim(),
      market: HOME_MARKET,
      intent: 'informational',
    }));
    console.log(`  📝  Using CLI topics: ${seeds.map(s => s.topic).join(', ')}`);
  }

  if (REPORT) {
    console.log('\n' + '═'.repeat(60));
    console.log('  SEED TOPICS REPORT');
    console.log('═'.repeat(60));
    seeds.forEach((s, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. "${s.topic}" (${s.market.toUpperCase()}, ${s.intent})`);
    });
    console.log('═'.repeat(60));
    console.log(`  ${seeds.length} seed topics configured`);
    console.log('  Run without --report to discover keywords from these seeds.\n');
    process.exit(0);
  }

  runDiscovery(null, { seeds })
    .then(count => {
      console.log(`\n═══ DISCOVERY SUMMARY: ${count} new keywords added ═══\n`);
      process.exit(0);
    })
    .catch(err => {
      console.error(`\n❌  Discovery failed: ${err.message}\n${err.stack}`);
      process.exit(1);
    });
}
