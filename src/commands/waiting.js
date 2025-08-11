// src/commands/waiting.js
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');
const waitingTracker = require('../waitingTracker');

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
function stripNonWord(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function stripDigits(s) { return String(s || '').replace(/\d+/g, ''); }

function levenshtein(a, b) {
  a = normalizeName(a); b = normalizeName(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function bestMatchPlayer(rows, query) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const qNorm = normalizeName(query);
  const qTight = stripNonWord(query);
  const qNoDigits = stripDigits(qNorm).replace(/\s+/g, '');
  let exact = rows.find(r => normalizeName(r.Player || r.player || '') === qNorm);
  if (exact) return { row: exact, score: 0 };
  const scored = [];
  for (const r of rows) {
    const name = r.Player || r.player || '';
    const nNorm = normalizeName(name);
    const nTight = stripNonWord(name);
    const nNoDigits = stripDigits(nNorm).replace(/\s+/g, '');
    let tier = 3;
    if (nNorm.startsWith(qNorm) || nNoDigits.startsWith(qNoDigits) || nTight.startsWith(qTight)) tier = 0;
    else if (nNorm.includes(qNorm) || nNoDigits.includes(qNoDigits) || nTight.includes(qTight)) tier = 1;
    else tier = 2;
    const d = levenshtein(name, query);
    const maxLen = Math.max(String(name).length, String(query).length) || 1;
    const normD = d / maxLen;
    scored.push({ row: r, tier, d, normD });
  }
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.normD !== b.normD) return a.normD - b.normD;
    if (a.d !== b.d) return a.d - b.d;
    const toNum = (val) => { const cleaned = String(val ?? '').replace(/[^0-9]/g, ''); return cleaned ? parseInt(cleaned, 10) : 0; };
    const aRating = toNum(a.row['Personal clan rating'] ?? a.row.rating);
    const bRating = toNum(b.row['Personal clan rating'] ?? b.row.rating);
    return bRating - aRating;
  });
  return scored.length ? scored[0] : null;
}

function toNumber(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = {
  data: {
    name: 'waiting',
    description: 'Show members waiting in the configured voice channel with time and squadron rating',
  },
  async execute(interaction) {
    const waiters = waitingTracker.getWaiting();
    if (!Array.isArray(waiters) || waiters.length === 0) {
      await interaction.reply({ content: 'No one is currently waiting.', flags: MessageFlags.Ephemeral });
      return;
    }
    const snap = readLatestSquadronSnapshot();
    const rows = snap && snap.data && Array.isArray(snap.data.rows) ? snap.data.rows : [];

    const out = [];
    for (const w of waiters) {
      let display = `<@${w.userId}>`;
      try {
        const gm = interaction.guild?.members?.cache?.get(w.userId) || (interaction.guild ? await interaction.guild.members.fetch(w.userId) : null);
        if (gm) display = gm.nickname || gm.user?.username || display;
      } catch (_) {}
      let rating = 'N/A';
      if (rows.length && display) {
        const found = bestMatchPlayer(rows, display);
        if (found && found.row) {
          rating = found.row['Personal clan rating'] ?? found.row.rating ?? 'N/A';
        }
      }
      out.push({ name: display, seconds: w.seconds, rating: toNumber(rating) });
    }

    // Sort by waiting longest first
    out.sort((a, b) => b.seconds - a.seconds);

    const lines = out.map((x, i) => `${String(i + 1).padStart(2, ' ')}. ${x.name} — ${formatDuration(x.seconds)} — ${x.rating}`);
    const header = 'Waiting in voice channel:';
    const content = '```\n' + header + '\n\n' + lines.join('\n') + '\n```';
    await interaction.reply({ content });
  }
};
