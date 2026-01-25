// src/nameMatch.js
const Fuse = require('fuse.js');
const { sanitizeName } = require('./utils/nameSanitizer');

function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNonWord(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stripDigits(s) {
  return String(s || '').replace(/\d+/g, '');
}

// Remove any bracketed segments like (TAG), [TAG], {TAG}, <TAG>
function stripBracketed(s) {
  return String(s || '')
    .replace(/[\(\[\{<][^\)\]\}>]*[\)\]\}>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  a = normalizeName(a);
  b = normalizeName(b);
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function toNumber(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}

function bestMatchPlayer(rows, query) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  function scoreRows(q) {
    const qNorm = normalizeName(q);
    const qTight = stripNonWord(q);
    const qNoDigits = stripDigits(qNorm).replace(/\s+/g, '');

    let exact = rows.find(r => normalizeName(r.Player || r.player || '') === qNorm);
    if (exact) return { row: exact, tier: -1, d: 0, normD: 0 };

    const scored = [];
    for (const r of rows) {
      const name = r.Player || r.player || '';
      const nNorm = normalizeName(name);
      const nTight = stripNonWord(name);
      const nNoDigits = stripDigits(nNorm).replace(/\s+/g, '');

      let tier = 3; // lower is better
      if (nNorm.startsWith(qNorm) || nNoDigits.startsWith(qNoDigits) || nTight.startsWith(qTight)) {
        tier = 0; // strong prefix match
      } else if (nNorm.includes(qNorm) || nNoDigits.includes(qNoDigits) || nTight.includes(qTight)) {
        tier = 1; // substring match
      } else {
        tier = 2; // fall back to edit distance
      }

      const d = levenshtein(name, q);
      const maxLen = Math.max(String(name).length, String(q).length) || 1;
      const normD = d / maxLen;
      scored.push({ row: r, tier, d, normD });
    }

    scored.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.normD !== b.normD) return a.normD - b.normD;
      if (a.d !== b.d) return a.d - b.d;
      const aRating = toNumber(a.row['Personal clan rating'] ?? a.row.rating);
      const bRating = toNumber(b.row['Personal clan rating'] ?? b.row.rating);
      return bRating - aRating;
    });

    return scored.length ? scored[0] : null;
  }

  const primary = scoreRows(query);
  const stripped = stripBracketed(query);
  if (!stripped || normalizeName(stripped) === normalizeName(query)) {
    return primary;
  }
  const alt = scoreRows(stripped);
  if (!primary) return alt;
  if (!alt) return primary;
  // Pick the better of the two
  if (alt.tier !== primary.tier) return alt.tier < primary.tier ? alt : primary;
  if (alt.normD !== primary.normD) return alt.normD < primary.normD ? alt : primary;
  if (alt.d !== primary.d) return alt.d < primary.d ? alt : primary;
  return primary;
}

function fuseMatch(items, query, keys = ['name']) {
  const fuseOptions = { keys };
  const sanitizedQuery = sanitizeName(query.replace(/\([^)]*\)/g, ''));
  return new Fuse(items, fuseOptions).search(sanitizedQuery)[0] || null;
}

module.exports = {
  normalizeName,
  stripNonWord,
  stripDigits,
  stripBracketed,
  levenshtein,
  toNumber,
  bestMatchPlayer,
  fuseMatch,
};
