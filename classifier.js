const fs = require('fs');
const path = require('path');

// Replace NBSP and multiple whitespace with single ascii space, remove diacritics, trim
const normalizeWhitespaceAndDiacritics = (s) => {
  return s
    .replace(/\u00A0/g, ' ') // NBSP -> space
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/\s+/g, ' ')
    .trim();
};


// Remove leading non-alphanumeric symbols (e.g., squad icons like ␗, ▅)
const stripLeadingSymbols = (s) => s.replace(/^[^\p{L}\p{N}]+/u, '');

// Standardize punctuation variants for comparison (remove parentheses, collapse hyphens)
const normalizePunct = (s) => s
  .replace(/[()]/g, '')
  .replace(/\s*-\s*/g, '-')
  .replace(/-/g, ' ') // treat hyphen as space for lenient matching
  .trim();

// Build a normalized form used for equality/partial comparisons
const normalizeVehicleName = (name) => {
  if (!name || typeof name !== 'string') return '';
  let out = String(name);
  out = normalizeWhitespaceAndDiacritics(out);
  out = stripLeadingSymbols(out);
  out = normalizePunct(out);
  return out.toLowerCase();
};

module.exports.normalizeVehicleName = normalizeVehicleName;

const loadClassifications = () => {
  try {
    const comp = JSON.parse(fs.readFileSync(path.join(__dirname, 'comprehensive_vehicle_classifications.json'), 'utf8'));
    return comp;
  } catch (e) {
    // If comprehensive is missing/unreadable, return an empty mapping.
    // Heuristic/pattern matching and wiki overrides will still function.
    return {};
  }
};

// Overrides removed: all mappings are now consolidated into comprehensive_vehicle_classifications.json

// Extract unique vehicles from 4D or legacy structures
const extractVehicles = (data) => {
  const vehicles = new Set();

  if (Array.isArray(data)) {
    data.forEach(entry => { if (entry && entry[3]) vehicles.add(entry[3]); });
    return Array.from(vehicles);
  }

  if (data && typeof data === 'object') {
    Object.keys(data).forEach(gameKey => {
      if (gameKey.startsWith('_')) return; // skip metadata like _gameState
      const game = data[gameKey];
      if (!game || typeof game !== 'object') return;
      Object.keys(game).forEach(sq => {
        const squad = game[sq];
        if (!squad || typeof squad !== 'object') return;
        Object.keys(squad).forEach(player => {
          const p = squad[player];
          if (!p || typeof p !== 'object') return;
          Object.keys(p).forEach(vehicle => {
            if (vehicle && vehicle !== '_gameState') vehicles.add(vehicle);
          });
        });
      });
    });
  }

  return Array.from(vehicles);
};

// Export for external usage
module.exports.extractVehicles = extractVehicles;

// Main classifier with exact and partial normalized matching + pattern heuristics
const classifyVehicle = (vehicleName, classifications) => {
  if (!vehicleName) return 'other';
  const nameNorm = normalizeVehicleName(vehicleName);
  if (!nameNorm) return 'other';

  // Precompute normalized lookup per category
  const categories = Object.keys(classifications);

  // 1) Exact normalized match
  for (const cat of categories) {
    if (cat === 'other') continue;
    const list = classifications[cat] || [];
    if (list.some(v => normalizeVehicleName(v) === nameNorm)) return cat;
  }

  // 2) Partial contains match with scoring
  const scores = {};
  for (const cat of categories) {
    if (cat === 'other') continue;
    const list = classifications[cat] || [];
    for (const v of list) {
      const vn = normalizeVehicleName(v);
      if (!vn) continue;
      if (nameNorm.includes(vn) || vn.includes(nameNorm)) {
        const score = Math.min(vn.length, nameNorm.length);
        scores[cat] = Math.max(scores[cat] || 0, score);
      }
    }
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] >= 3) return best[0];

  // 3) Heuristic patterns on normalized name
  const n = nameNorm;
  const patterns = {
    bombers: [/^b-?\d+\b/, /^il-?\d+\b/, /^tu-?\d+\b/, /^pe-?\d+\b/, /^he\s?\d+\b/, /^ju\s?\d+\b/, /^do\s?\d+\b/],
    tanks: [/^t-?\d+\b/, /^m\d+\b/, /^is-?\d+\b/, /\bpanzer\b/, /\btiger\b/, /\bpanther\b/, /\bleopard\b/, /\bcenturion\b/, /\bchallenger\b/, /\bchieftain\b/],
    light_scout: [/^m\d+\s/, /^bmp\b/, /^btr\b/, /^pt-?\d+\b/, /^asu-?\d+\b/, /^type\s?\d+\b/, /^m2[24]\b/, /^m3[15]\b/, /^object\b/, /^stb\b/, /^ru\s?251\b/, /^t92\b/],
    fixed_wing: [/^[a-z]+-?\d+\b/, /^[a-z]+\s\d+\b/, /^[a-z]\d+\b/, /^[a-z]{2}-\d+\b/],
    helicopters: [/^[a-z]+-?\d+\b/, /^mi-?\d+\b/, /^ah-?\d+\b/, /^uh-?\d+\b/, /^ka-?\d+\b/, /^oh-?\d+\b/],
    anti_air: [/\baa\b/, /spaa/, /flak/, /\bzsu\b/, /shilka/, /tunguska/, /gepard/, /type\s?87\b/, /\bm163\b/, /vads/],
    naval: [/^[a-z]{2,3}-?\d+\b/, /^[a-z]+\s\d+\b/, /\bpt-?\d+\b/, /\bpr\./, /type\s[a-z]\d+\b/, /^[a-z]+\d+[a-z]*\b/]
  };
  for (const [cat, regs] of Object.entries(patterns)) {
    if (regs.some(r => r.test(n))) return cat;
  }

  return 'other';
};

// (legacy exports removed)

// ---------------- New-format helpers (vehicle -> category) ----------------
// Load comprehensive classifications supporting both formats.
// Returns { vehicleToCategory, vehicleClassifications }
function loadVehicleClassifications() {
  let vehicleToCategory = {};
  let vehicleClassifications = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'comprehensive_vehicle_classifications.json'), 'utf8'));
    const isNewFormat = raw && Object.values(raw)[0] && typeof Object.values(raw)[0] === 'string';
    if (isNewFormat) {
      // Normalize categories to Title Case for UI/OUTPUT_ORDER compatibility
      vehicleToCategory = {};
      vehicleClassifications = {};
      Object.entries(raw).forEach(([veh, catRaw]) => {
        const mapped = _mapNewTaxonomyToTitleCase(catRaw) || String(catRaw);
        vehicleToCategory[veh] = mapped;
        if (!vehicleClassifications[mapped]) vehicleClassifications[mapped] = [];
        vehicleClassifications[mapped].push(veh);
      });
    } else {
      vehicleClassifications = raw || {};
      vehicleToCategory = {};
      Object.entries(vehicleClassifications).forEach(([cat, list]) => {
        (list || []).forEach(v => { vehicleToCategory[v] = cat; });
      });
    }
    return { vehicleToCategory, vehicleClassifications };
  } catch (e) {
    // empty maps
  }
}

// Expose helpers
module.exports.loadVehicleClassifications = loadVehicleClassifications;

// (Removed legacy classifyVehicleNewTaxonomy)

// Strict classifier: return exactly what's in the table or 'other'.
// No heuristics, no enrichment, no normalization beyond trim.
function classifyVehicleStrict(name, vehicleToCategory) {
  if (!name || typeof name !== 'string') return 'other';
  const clean = name.trim();
  return vehicleToCategory && Object.prototype.hasOwnProperty.call(vehicleToCategory, clean)
    ? vehicleToCategory[clean]
    : 'other';
}

module.exports.classifyVehicleStrict = classifyVehicleStrict;

// Strict + background enrichment using enrich_from_wiki.js
const _pendingWiki = new Set();

function _mapNewTaxonomyToTitleCase(cat) {
  switch (cat) {
    case 'heavy_tank': return 'Heavy Tank';
    case 'medium_tank': return 'Medium Tank';
    case 'light_tank': return 'Light Tank';
    case 'spg': return 'Tank destroyer';
    case 'spaa': return 'SPAA';
    case 'bomber': return 'Bomber';
    case 'fighter':
    case 'attacker':
    case 'fixed_wing': return 'Fighter';
    case 'helicopter': return 'Helicopter';
    default: return null;
  }
}

function _persistVehicleMapping(vehicleName, categoryTitle) {
  try {
    const file = path.join(__dirname, 'comprehensive_vehicle_classifications.json');
    let raw = {};
    if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const isMap = raw && typeof Object.values(raw)[0] === 'string';
    let map = {};
    if (isMap) {
      map = raw;
    } else {
      Object.entries(raw || {}).forEach(([cat, list]) => {
        if (Array.isArray(list)) list.forEach(v => { map[v] = cat; });
      });
    }
    if (!map[vehicleName]) {
      map[vehicleName] = categoryTitle;
      fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf8');
    }
  } catch (e) {
    console.error('❌ Failed saving classification:', e);
  }
}

function classifyVehicleStrictWithEnrichment(name, vehicleToCategory) {
  const res = classifyVehicleStrict(name, vehicleToCategory);
  if (res !== 'other') return res;

  const vehicleName = String(name || '').trim();
  if (!vehicleName || _pendingWiki.has(vehicleName)) return 'other';
  _pendingWiki.add(vehicleName);

  (async () => {
    try {
      const { classifyViaWiki } = require('./enrich_from_wiki');
      const result = await classifyViaWiki(vehicleName);
      if (result && result.category) {
        const title = _mapNewTaxonomyToTitleCase(result.category);
        if (title) {
          console.log(`🔎 Learned from Wiki: ${vehicleName} -> ${title} (${result.source || 'wiki'})`);
          _persistVehicleMapping(vehicleName, title);
          if (vehicleToCategory) vehicleToCategory[vehicleName] = title;
        }
      }
    } catch (_) {
      // ignore
    } finally {
      _pendingWiki.delete(vehicleName);
    }
  })();

  return 'other';
}

module.exports.classifyVehicleStrictWithEnrichment = classifyVehicleStrictWithEnrichment;

// Duplicate legacy block removed
