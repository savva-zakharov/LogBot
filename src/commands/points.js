// src/commands/points.js
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');

function readLatestSquadronSnapshot() {
  try {
    const file = path.join(process.cwd(), 'squadron_data.json');
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    const arr = Array.isArray(obj.squadronSnapshots) ? obj.squadronSnapshots : [];
    return arr.length ? arr[arr.length - 1] : null;
  } catch (_) {
    return null;
  }
}

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

// Levenshtein distance
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
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[m][n];
}

function bestMatchPlayer(rows, query) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const qNorm = normalizeName(query);
  const qTight = stripNonWord(query);
  const qNoDigits = stripDigits(qNorm).replace(/\s+/g, '');

  // 1) Exact (normalized) match
  let exact = rows.find(r => normalizeName(r.Player || r.player || '') === qNorm);
  if (exact) return { row: exact, score: 0 };

  // 2) Prefix / substring heuristic, including digit-stripped variants
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

    const d = levenshtein(name, query);
    const maxLen = Math.max(String(name).length, String(query).length) || 1;
    const normD = d / maxLen;
    scored.push({ row: r, tier, d, normD });
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.normD !== b.normD) return a.normD - b.normD;
    if (a.d !== b.d) return a.d - b.d;
    // tie-breaker: higher rating
    const toNum = (val) => {
      const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
      return cleaned ? parseInt(cleaned, 10) : 0;
    };
    const aRating = toNum(a.row['Personal clan rating'] ?? a.row.rating);
    const bRating = toNum(b.row['Personal clan rating'] ?? b.row.rating);
    return bRating - aRating;
  });

  return scored.length ? scored[0] : null;
}

module.exports = {
  data: {
    name: 'points',
    description: 'Show a player\'s Personal clan rating (defaults to you) from the latest snapshot',
    options: [
      {
        name: 'player',
        description: 'Player name to look up (optional)',
        type: 3, // STRING
        required: false,
      }
    ],
  },
  async execute(interaction) {
    const caller = interaction.member?.nickname || interaction.user?.username || interaction.member?.user?.username || 'Unknown';
    const queryInput = (interaction.options && typeof interaction.options.getString === 'function')
      ? interaction.options.getString('player')
      : null;
    const targetName = queryInput && queryInput.trim() ? queryInput.trim() : (interaction.member?.nickname || interaction.user?.username);
    const snap = readLatestSquadronSnapshot();
    if (!snap || !snap.data || !Array.isArray(snap.data.rows) || snap.data.rows.length === 0) {
      await interaction.reply({ content: 'No squadron data available yet. Please try again later.', flags: MessageFlags.Ephemeral });
      return;
    }

    const found = bestMatchPlayer(snap.data.rows, targetName);
    if (!found || !found.row) {
      await interaction.reply({ content: `Could not find a close match for \`${targetName || caller}\` in the latest squadron snapshot.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const row = found.row;
    const rating = row['Personal clan rating'] ?? row.rating ?? 'N/A';
    const playerName = row.Player || 'Unknown player';

    let header = `Player: ${playerName}\nPersonal clan rating: ${rating}`;
    if (typeof snap.totalPoints === 'number' || typeof snap.totalPointsCalulated === 'number') {
      const totalScraped = snap.totalPoints != null ? snap.totalPoints : 'N/A';
      const totalCalc = snap.totalPointsCalulated != null ? snap.totalPointsCalulated : 'N/A';
      header += `\nSquadron total: ${totalScraped}`;
    }

    await interaction.reply({ content: '```\n' + header + '\n```' });
  }
};
