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

// New taxonomy classifier: light_tank, medium_tank, heavy_tank, spg, spaa, fighter, attacker, bomber, helicopter
const classifyVehicleNewScheme = (vehicleName, classifications) => {
  const n = normalizeVehicleName(vehicleName);

  // 0) No overrides: classification relies on comprehensive database + heuristics

  const base = classifyVehicle(vehicleName, classifications);

  // Direct mappings
  if (base === 'light_scout') return 'light_tank';
  if (base === 'anti_air') return 'spaa';
  if (base === 'bombers') return 'bomber';
  if (base === 'helicopters') return 'helicopter';

  // Aircraft split: fighter vs attacker
  if (base === 'fixed_wing') {
    const attackerPatterns = [
      /^a-?\d+\b/, /\bil-?2\b/, /\bil-?10\b/, /\bhs\s?129\b/, /\bme\s?410\b/,
      /\bsu-?(7|17|22|25)\b/, /\byak-?38\b/, /\byak-?130\b/, /\bthunderbolt\b/, /\bskyraider\b/
    ];
    if (attackerPatterns.some(r => r.test(n))) return 'attacker';
    return 'fighter';
  }

  // Ground split: spg vs heavy vs medium
  if (base === 'tanks') {
    // SPG / Tank destroyer indicators
    const spgPatterns = [
      /\bjagd/i, /\bstug\b/i, /sturmpanzer/i, /\bisu-?\d*/i, /\bsu-?\d+/i, /\basu-?\d+/i,
      /\bobj(ect)?\s?(268|704)\b/i, /\bt95\b/i, /\bt28\b/i, /\barcher\b/i, /\bachilles\b/i,
      /ho-?ri/i, /\b2s1\b/i, /\b2s19\b/i, /\bsub-?i-?ii\b/i, /\bu-?sh\s?204\b/i
    ];
    if (spgPatterns.some(r => r.test(vehicleName))) return 'spg';

    // Heavy tank indicators
    const heavyPatterns = [
      /\bkv\b/i, /\bis-?\d+/i, /\btiger\b/i, /\bm103\b/i, /\b(t29|t30|t32|t34)\b/i,
      /\bconqueror\b/i, /\bchieftain\b/i, /\bmaus\b/i, /\be-?100\b/i, /\bst-?i{1,2}\b/i,
      /\btiger\s?ii\b/i, /\btiger\s?i\b/i, /\bconway\b/i, /\bt26e1-?1\b/i, /\bt26e5\b/i, /super\s?pershing/i
    ];
    if (heavyPatterns.some(r => r.test(vehicleName))) return 'heavy_tank';

    return 'medium_tank';
  }

  return 'other';
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

module.exports = {
  loadClassifications,
  normalizeVehicleName,
  classifyVehicle,
  classifyVehicleNewScheme,
  extractVehicles,
};
