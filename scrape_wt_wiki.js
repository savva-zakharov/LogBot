const fs = require('fs');
const path = require('path');
const https = require('https');
const { normalizeVehicleName } = require('./classifier');

const WIKI_BASE = 'https://wiki.warthunder.com';
const COMPREHENSIVE_FILE = path.join(__dirname, 'comprehensive_vehicle_classifications.json');

// ---- HTTP helpers ----
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

// ---- Name helpers ----
function sanitizeForWiki(title) {
  let t = title.replace(/\u00A0/g, ' ').trim(); // NBSP -> space
  t = t.replace(/^[^\p{L}\p{N}]+/u, ''); // strip leading symbols
  t = t.replace(/[()]/g, '');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\//g, '_');
  t = t.replace(/\s/g, '_');
  return t;
}

function toTitleTokens(str) {
  // Build Title-Case tokens from normalized name
  const tokens = String(str || '')
    .replace(/\u00A0/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[()]/g, '')
    .replace(/\s*[-_/]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  return tokens.map(tok => {
    if (/^mk$/i.test(tok)) return 'Mk';
    if (/^[ivxlcdm]+$/i.test(tok)) return tok.toUpperCase();
    if (/^([a-z])\.$/i.test(tok)) return RegExp.$1.toUpperCase(); // A. -> A
    if (/^[a-z]\d+$/i.test(tok)) return tok.toUpperCase(); // e.g., m41 -> M41
    // keep case for mixed alpha-num like T-72 (hyphen removed earlier)
    return tok.length > 1 ? tok[0].toUpperCase() + tok.slice(1) : tok.toUpperCase();
  });
}

function toSlug(name) {
  // Lowercase, remove diacritics, normalize spaces/hyphens, and insert underscores between letter-digit boundaries
  let s = String(name || '')
    .replace(/\u00A0/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[()]/g, '')
    .replace(/\s*[-\s\/+_]\s*/g, '_')
    .trim()
    .toLowerCase();
  // insert underscore between digit->letter and letter->digit transitions
  s = s.replace(/(\d)([a-z])/g, '$1_$2').replace(/([a-z])(\d)/g, '$1_$2');
  // collapse multiple underscores
  s = s.replace(/_+/g, '_');
  return s;
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
    .replace(/\biii\b/i, 'III')
    .replace(/\bii\b/i, 'II')
    .replace(/\bi\b/i, 'I')
    .trim()
    .replace(/\s/g, '_');
  variants.add(base);

  // Lenient variants:
  // 1) Drop trailing single-letter suffix token (e.g., "Tiger_II_H" -> "Tiger_II")
  variants.forEach(v => {
    const drop = v.replace(/_([A-Za-z])$/, '');
    variants.add(drop);
  });

  // 2) Title-Case reconstruction from normalized tokens
  if (n) {
    const tt = toTitleTokens(n);
    if (tt.length) {
      variants.add(sanitizeForWiki(tt.join(' ')));
      // also drop last token if it's short (like H, P, A)
      if (tt[tt.length - 1] && tt[tt.length - 1].length <= 2) {
        variants.add(sanitizeForWiki(tt.slice(0, -1).join(' ')));
      }
    }
  }

  const urls = [];
  // Prefer direct /unit paths for common nations first (helps cases like 2S19M1 -> ussr_2s19_m1)
  const slug = toSlug(name);
  const nations = ['ussr','usa','germany','britain','japan','italy','france','china','sweden','israel'];
  for (const nat of nations) {
    urls.push(`${WIKI_BASE}/unit/${nat}_${encodeURIComponent(slug)}`);
  }
  // Also try without nation prefix
  urls.push(`${WIKI_BASE}/unit/${encodeURIComponent(slug)}`);
  for (const v of variants) {
    urls.push(`${WIKI_BASE}/${encodeURIComponent(v)}`);
    urls.push(`${WIKI_BASE}/index.php?search=${encodeURIComponent(v)}&title=Special%3ASearch&profile=advanced&fulltext=1`);
  }
  return Array.from(new Set(urls));
}

// ---- HTML parsing ----
// Extract the role slug from the dedicated collections link present on unit pages.
// Expected href format: /collections/game_roles/<role_slug>
function extractRoleFromHtml(html) {
  const roles = ['heavy_tank','medium_tank','light_tank','spg','spaa','fighter','bomber','attacker','helicopter'];
  const h = html.toLowerCase();
  // Direct role link
  const m = h.match(/href\s*=\s*\"(?:https?:\/\/wiki\.warthunder\.com)?\/collections\/game_roles\/([a-z_]+)\"/i);
  if (m && roles.includes(m[1])) return m[1];
  // Occasionally single quotes
  const m2 = h.match(/href\s*=\s*\'(?:https?:\/\/wiki\.warthunder\.com)?\/collections\/game_roles\/([a-z_]+)\'/i);
  if (m2 && roles.includes(m2[1])) return m2[1];
  return null;
}

async function classifyViaWiki(name, opts = {}) {
  const candidates = buildCandidateUrls(name);
  for (const url of candidates) {
    try {
      const { html, url: finalUrl } = await fetchUrl(url);
      const isUnitPage = /^https?:\/\/wiki\.warthunder\.com\/unit\//i.test(finalUrl);
      if (isUnitPage) {
        if (opts.verbose) console.log(`  found unit page: ${finalUrl}`);
        const role = extractRoleFromHtml(html);
        if (role) return { category: role, source: finalUrl, found: true };
        // Page found but no role link
        return { category: null, source: finalUrl, found: true };
      }

      // If it's a search page, try multiple results; enforce unit-page + role link
      if (/Special%3ASearch/.test(url)) {
        const links = [];
        const re = /<a[^>]+href=\"(\/[^\"]+)\"[^>]*class=\"mw-search-result-heading\"|class=\"mw-search-result-heading\"[\s\S]*?<a[^>]+href=\"(\/[^\"]+)/gi;
        let m;
        while ((m = re.exec(html)) && links.length < 10) {
          const href = m[1] || m[2];
          if (href) links.push(href);
        }
        for (const href of links) {
          const nextUrl = href.startsWith('http') ? href : `${WIKI_BASE}${href}`;
          try {
            const r = await fetchUrl(nextUrl);
            const isUnit = /^https?:\/\/wiki\.warthunder\.com\/unit\//i.test(r.url);
            if (isUnit) {
              if (opts.verbose) console.log(`  from search -> unit page: ${r.url}`);
              const role2 = extractRoleFromHtml(r.html);
              if (role2) return { category: role2, source: r.url, found: true };
              return { category: null, source: r.url, found: true };
            }
          } catch (_) {}
          await sleep(300);
        }
      }
    } catch (e) {}
    await sleep(800);
  }
  return { category: null, source: null, found: false };
}

// ---- JSON helpers ----
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
  // Backups are handled by the pipeline; write directly here to avoid many backups per run.
  fs.writeFileSync(COMPREHENSIVE_FILE, JSON.stringify(data, null, 2));
}

function mapWikiToJsonCategory(cat) {
  switch (cat) {
    case 'heavy_tank': return 'Heavy Tank';
    case 'medium_tank': return 'Medium Tank';
    case 'light_tank': return 'Light Tank';
    case 'spg': return 'Tank destroyer';
    case 'spaa': return 'SPAA';
    case 'fighter': return 'Fighter';
    case 'bomber': return 'Bomber';
    case 'attacker': return 'Attacker';
    case 'helicopter': return 'Helicopter';
    default: return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const VERBOSE = args.includes('--verbose') || process.env.WT_VERBOSE === '1';
  const names = args.filter(a => !a.startsWith('--'));
  if (names.length === 0) {
    console.log('Usage: node scrape_wt_wiki.js "Vehicle Name" ["Another Vehicle" ...]');
    console.log('Tip: you can pass many names; the script will classify via wiki and update comprehensive_vehicle_classifications.json');
    process.exit(0);
  }

  const comprehensive = loadComprehensive();

  console.log(`Classifying ${names.length} vehicles via War Thunder Wiki...`);
  for (const rawName of names) {
    const name = rawName.trim();
    const existing = comprehensive[name];
    process.stdout.write(`- ${name}: `);
    const result = await classifyViaWiki(name, { verbose: VERBOSE });
    if (result && result.category) {
      const mapped = mapWikiToJsonCategory(result.category);
      if (mapped) {
        if (!existing) {
          comprehensive[name] = mapped;
          console.log(`${mapped} (${result.source})`);
        } else if (existing !== mapped) {
          comprehensive[name] = mapped;
          console.log(`override ${existing} -> ${mapped} (${result.source})`);
        } else {
          console.log(`confirmed ${existing} (${result.source})`);
        }
      } else {
        console.log(`found ${result.category} but no mapping${result.source ? ` (${result.source})` : ''}`);
      }
    } else {
      if (result && result.found && result.source) {
        // Unit page found but no role link
        if (!existing) {
          console.log(`unit page found but no role link (${result.source})`);
        } else {
          console.log(`unit page found but no role link; keeping existing ${existing} (${result.source})`);
        }
      } else {
        if (existing) {
          console.log(`no unit page found; keeping existing ${existing}`);
        } else {
          console.log('no unit page found');
        }
      }
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
