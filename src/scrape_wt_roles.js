const https = require('https');
const fs = require('fs');
const path = require('path');

const WIKI_BASE = 'https://wiki.warthunder.com';
const ROLES = {
  light_tank: 'Light Tank',
  medium_tank: 'Medium Tank',
  heavy_tank: 'Heavy Tank',
  spaa: 'SPAA',
  tank_destroyer: 'Tank destroyer',
  fighter: 'Fighter',
  assault: 'Attacker', // map to Attacker
  bomber: 'Bomber',
};

// Corrected path to be relative to the project root
const COMPREHENSIVE_FILE = path.join(__dirname, '../comprehensive_vehicle_classifications.json');

function fetchUrl(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'LogBot-WT/1.0 (+classification roles scraper)'
      },
      timeout: 15000,
    }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && depth < 5) {
        const next = loc.startsWith('http') ? loc : `${WIKI_BASE}${loc}`;
        res.resume();
        return resolve(fetchUrl(next, depth + 1));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ html: data, url }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function htmlDecode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseUnitsFromRolePage(html) {
  const units = new Set();
  // Find anchors that go to /unit/...
  const re = /<a\b[^>]*href="(\/unit\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = stripTags(m[2]);
    const name = htmlDecode(text);
    if (name && /\S/.test(name)) {
      units.add(name);
    }
  }
  return Array.from(units);
}

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
  fs.writeFileSync(COMPREHENSIVE_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function main() {
  const args = process.argv.slice(2);
  const VERBOSE = args.includes('--verbose') || process.env.WT_VERBOSE === '1';
  const NO_BACKUP = args.includes('--no-backup');

  if (!NO_BACKUP && fs.existsSync(COMPREHENSIVE_FILE)) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = COMPREHENSIVE_FILE.replace(/\.json$/, `.${ts}.bak.json`);
      fs.copyFileSync(COMPREHENSIVE_FILE, backup);
      if (VERBOSE) console.log('Backup created:', backup);
    } catch (e) {
      console.warn('Warning: failed to create backup:', e.message);
    }
  }

  const comprehensive = loadComprehensive();

  let totalFound = 0;
  for (const [roleSlug, mappedCategory] of Object.entries(ROLES)) {
    const url = `${WIKI_BASE}/collections/game_roles/${roleSlug}`;
    if (VERBOSE) console.log(`Fetching role page: ${url}`);
    try {
      const { html } = await fetchUrl(url);
      const units = parseUnitsFromRolePage(html);
      if (VERBOSE) console.log(`  units found: ${units.length}`);
      for (const name of units) {
        const existing = comprehensive[name];
        if (!existing) {
          comprehensive[name] = mappedCategory;
          if (VERBOSE) console.log(`  + ${name} -> ${mappedCategory}`);
          totalFound++;
        } else if (existing !== mappedCategory) {
          comprehensive[name] = mappedCategory;
          if (VERBOSE) console.log(`  ~ ${name}: override ${existing} -> ${mappedCategory}`);
          totalFound++;
        } else {
          if (VERBOSE) console.log(`  = ${name}: confirmed ${existing}`);
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch role page ${url}:`, e.message || e);
    }
    await sleep(500);
  }

  saveComprehensive(comprehensive);
  console.log(`Updated ${COMPREHENSIVE_FILE}. New/overridden entries from role pages: ${totalFound}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}
