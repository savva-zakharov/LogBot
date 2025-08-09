const fs = require('fs');
const path = require('path');
const https = require('https');
const { normalizeVehicleName } = require('./classifier');

const WIKI_BASE = 'https://wiki.warthunder.com';
const COMPREHENSIVE_FILE = path.join(__dirname, 'comprehensive_vehicle_classifications.json');

// ---------- HTTP helpers ----------
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'LogBot-Classifier/1.0 (+https://example.local)'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ html: data, url });
        if ([301,302,303,307,308].includes(res.statusCode)) {
          const loc = res.headers.location;
          if (loc) {
            const next = loc.startsWith('http') ? loc : `${WIKI_BASE}${loc}`;
            return fetchUrl(next).then(resolve).catch(reject);
          }
        }
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ---------- Name helpers ----------
function sanitizeForWiki(title) {
  let t = title.replace(/\u00A0/g, ' ').trim(); // NBSP -> space
  t = t.replace(/^[^\p{L}\p{N}]+/u, ''); // strip leading symbols
  t = t.replace(/[()]/g, '');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\//g, '_');
  t = t.replace(/\s/g, '_');
  return t;
}

function buildCandidateUrls(name) {
  const variants = new Set();
  variants.add(sanitizeForWiki(name));
  const n = normalizeVehicleName(name);
  if (n) variants.add(sanitizeForWiki(n));

  // Repair common roman numerals / Mk formatting
  const base = sanitizeForWiki(name)
    .replace(/_/g, ' ')
    .replace(/\bmk\.?\s?/i, 'Mk ')
    .replace(/\bii\b/i, 'II')
    .replace(/\bi\b/i, 'I')
    .trim()
    .replace(/\s/g, '_');
  variants.add(base);

  const urls = [];
  for (const v of variants) {
    urls.push(`${WIKI_BASE}/${encodeURIComponent(v)}`);
    urls.push(`${WIKI_BASE}/index.php?search=${encodeURIComponent(v)}&title=Special%3ASearch&profile=advanced&fulltext=1`);
  }
  return Array.from(new Set(urls));
}

// ---------- HTML parsing ----------
function guessTaxonomyFromHtml(html) {
  const h = html.toLowerCase();

  // infobox labels
  const clues = [];
  const addIf = (cond, v) => { if (cond) clues.push(v); };

  addIf(/heavy\s+tank/.test(h), 'heavy_tank');
  addIf(/medium\s+tank/.test(h), 'medium_tank');
  addIf(/light\s+tank/.test(h), 'light_tank');
  addIf(/tank\s+destroyer|\btd\b|self[- ]propelled\s+gun|\bspg\b/.test(h), 'spg');
  addIf(/anti[- ]air|\bspaa\b|self[- ]propelled\s+anti[- ]air/.test(h), 'spaa');

  addIf(/\bhelicopter\b/.test(h), 'helicopter');
  addIf(/\bbomber\b/.test(h), 'bomber');
  addIf(/attacker|strike\s+aircraft|ground\s+attack/.test(h), 'attacker');
  addIf(/\bfighter\b/.test(h), 'fighter');

  const priority = ['heavy_tank','medium_tank','light_tank','spg','spaa','attacker','fighter','bomber','helicopter'];
  for (const p of priority) if (clues.includes(p)) return p;
  return null;
}

async function classifyViaWiki(name) {
  const candidates = buildCandidateUrls(name);
  for (const url of candidates) {
    try {
      const { html, url: finalUrl } = await fetchUrl(url);
      const guess = guessTaxonomyFromHtml(html);
      if (guess) return { category: guess, source: finalUrl };

      // If it's a search page, try follow the first result
      if (/Special%3ASearch/.test(url)) {
        const m = html.match(/class=\"mw-search-result-heading\"[\s\S]*?<a[^>]+href=\"(\/[^\"]+)/i) || html.match(/<a[^>]+href=\"(\/[^\"]+)\"[^>]*class=\"mw-search-result-heading\"/i);
        if (m && m[1]) {
          const nextUrl = m[1].startsWith('http') ? m[1] : `${WIKI_BASE}${m[1]}`;
          try {
            const r = await fetchUrl(nextUrl);
            const g2 = guessTaxonomyFromHtml(r.html);
            if (g2) return { category: g2, source: r.url };
          } catch (_) {}
        }
      }
    } catch (e) {
      // try next candidate
    }
    await sleep(800); // be polite
  }
  return null;
}

// ---------- Load/Save comprehensive classifications ----------
function loadComprehensive() {
  try {
    const raw = fs.readFileSync(COMPREHENSIVE_FILE, 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : {};
  } catch (_) {
    return {};
  }
}

function saveComprehensive(data) {
  const backup = COMPREHENSIVE_FILE.replace(/\.json$/, `.${Date.now()}.bak.json`);
  try {
    if (fs.existsSync(COMPREHENSIVE_FILE)) fs.copyFileSync(COMPREHENSIVE_FILE, backup);
  } catch (_) {}
  fs.writeFileSync(COMPREHENSIVE_FILE, JSON.stringify(data, null, 2));
}

function mapNewTaxonomyToComprehensiveCategory(newCat) {
  switch (newCat) {
    case 'spaa': return 'anti_air';
    case 'bomber': return 'bombers';
    case 'fighter':
    case 'attacker': return 'fixed_wing';
    case 'helicopter': return 'helicopters';
    case 'light_tank': return 'light_scout';
    case 'medium_tank':
    case 'heavy_tank':
    case 'spg': return 'tanks';
    default: return null;
  }
}

// ---------- Candidates to enrich ----------
function findLatestBatchResult() {
  const files = fs.readdirSync('.').filter(f => /^classification_batch_results_.*\.json$/.test(f));
  if (files.length === 0) return null;
  files.sort();
  return files[files.length - 1];
}

function getUnclassifiedFromLatestBatch() {
  const latest = findLatestBatchResult();
  if (!latest) return [];
  try {
    const json = JSON.parse(fs.readFileSync(latest, 'utf8'));
    return Array.from(new Set(json.unclassifiedVehicles || []));
  } catch (_) {
    return [];
  }
}

// ---------- Main ----------
async function main() {
  const args = process.argv.slice(2);
  let targets = [];
  if (args.length > 0) {
    targets = args;
  } else {
    targets = getUnclassifiedFromLatestBatch();
  }

  if (!targets.length) {
    console.log('No vehicles to enrich (provide names as args or run the batch test first).');
    process.exit(0);
  }

  const comprehensive = loadComprehensive();
  // Ensure arrays exist
  const ensureArr = (k) => { if (!Array.isArray(comprehensive[k])) comprehensive[k] = []; };
  ['tanks','light_scout','bombers','fixed_wing','helicopters','anti_air','naval'].forEach(ensureArr);

  console.log(`Enriching ${targets.length} vehicles from War Thunder Wiki...`);

  for (const name of targets) {
    // Skip if already present in any category
    const exists = Object.values(comprehensive).some(arr => Array.isArray(arr) && arr.includes(name));
    if (exists) { console.log(`- Skipping already in DB: ${name}`); continue; }
    process.stdout.write(`- ${name} -> `);
    const result = await classifyViaWiki(name);
    if (result && result.category) {
      const targetKey = mapNewTaxonomyToComprehensiveCategory(result.category);
      if (targetKey) {
        ensureArr(targetKey);
        // If naval mistakenly contains ground/air entry, we can optionally clean, but we only add here
        if (!comprehensive[targetKey].includes(name)) comprehensive[targetKey].push(name);
        console.log(`${result.category} -> ${targetKey} (${result.source})`);
      } else {
        console.log(`${result.category} (no target category)`);
      }
    } else {
      console.log('not found');
    }
  }

  saveComprehensive(comprehensive);
  console.log(`\nUpdated ${COMPREHENSIVE_FILE}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
