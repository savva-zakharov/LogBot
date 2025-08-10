const fs = require('fs');
const path = require('path');

// Legacy normalization and heuristic code removed.

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

// (legacy heuristic classifier removed)

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
        const category = String(catRaw);
        vehicleToCategory[veh] = category;
        if (!vehicleClassifications[category]) vehicleClassifications[category] = [];
        vehicleClassifications[category].push(veh);
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

// Legacy background enrichment removed. Keep a no-op alias to avoid breaking callers.
function classifyVehicleStrictWithEnrichment(name, vehicleToCategory) {
  return classifyVehicleStrict(name, vehicleToCategory);
}

module.exports.classifyVehicleStrictWithEnrichment = classifyVehicleStrictWithEnrichment;

// Duplicate legacy block removed

// ---------------- Lenient matching (partial, case-insensitive, normalized) ----------------
// Lightweight normalization for matching
function _normalizeForMatch(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ') // NBSP -> space
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[\p{C}\p{S}]+/gu, '') // drop control and symbol glyphs (e.g., nation flags ▅, ␗)
    .replace(/[()]/g, '')
    .replace(/[_\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Cache normalized keys per mapping to avoid recomputing every call
const _normIndexCache = new WeakMap();
function _getNormIndex(vehicleToCategory) {
  if (!vehicleToCategory || typeof vehicleToCategory !== 'object') return { list: [], byNorm: new Map() };
  const cached = _normIndexCache.get(vehicleToCategory);
  if (cached) return cached;
  const list = [];
  const byNorm = new Map(); // norm -> array of original keys
  Object.keys(vehicleToCategory).forEach(orig => {
    const norm = _normalizeForMatch(orig);
    list.push({ orig, norm, cat: vehicleToCategory[orig] });
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm).push(orig);
  });
  const idx = { list, byNorm };
  _normIndexCache.set(vehicleToCategory, idx);
  return idx;
}

// Public lenient classifier
function classifyVehicleLenient(name, vehicleToCategory, options = {}) {
  if (!name || typeof name !== 'string') return 'other';
  if (!vehicleToCategory || typeof vehicleToCategory !== 'object') return 'other';

  const clean = name.trim();
  // 1) Strict exact match first
  if (Object.prototype.hasOwnProperty.call(vehicleToCategory, clean)) {
    return vehicleToCategory[clean];
  }

  const { list, byNorm } = _getNormIndex(vehicleToCategory);
  const q = _normalizeForMatch(clean);
  if (!q) return 'other';

  // 2) Exact normalized match
  const same = byNorm.get(q);
  if (same && same.length) {
    return vehicleToCategory[same[0]];
  }

  // 3) Contains/substring scoring
  let bestCat = null;
  let bestScore = 0;
  const minScore = options.minScore || 4; // require at least 4 chars overlap
  for (const entry of list) {
    const a = q;
    const b = entry.norm;
    let score = 0;
    if (a.includes(b) || b.includes(a)) {
      score = Math.min(a.length, b.length);
    } else {
      // token overlap score
      const at = a.split(' ');
      const bt = b.split(' ');
      const setA = new Set(at);
      let overlap = 0;
      for (const t of bt) if (setA.has(t)) overlap += t.length >= 2 ? t.length : 0; // weight by token length
      score = overlap;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCat = entry.cat;
    }
  }
  if (bestScore >= minScore && bestCat) return bestCat;
  return 'other';
}

module.exports.classifyVehicleLenient = classifyVehicleLenient;
