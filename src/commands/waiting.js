// src/commands/waiting.js
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');
const waitingTracker = require('../waitingTracker');
const { bestMatchPlayer, toNumber } = require('../nameMatch');
const { getConfig: getLowPointsConfig } = require('../lowPointsIssuer');

function readLatestSquadronSnapshot() {
  try {
    const file = path.join(process.cwd(), 'squadron_data.json');
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    // Legacy array format
    if (Array.isArray(obj.squadronSnapshots)) {
      const arr = obj.squadronSnapshots;
      return arr.length ? arr[arr.length - 1] : null;
    }
    // New single-snapshot format: the object itself is the snapshot
    return obj && typeof obj === 'object' && Object.keys(obj).length ? obj : null;
  } catch (_) {
    return null;
  }
}

// Name matching and numeric parsing are centralized in ../nameMatch

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
    const cfg = getLowPointsConfig ? getLowPointsConfig() : { threshold: 1300 };
    const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 1300;

    // Build Top 20 set from snapshot
    const top20Names = new Set();
    try {
      const ranked = rows
        .map(r => ({ r, rating: toNumber(r['Personal clan rating'] ?? r.rating), name: r.Player || r.player || '' }))
        .filter(x => x.name)
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 20);
      for (const x of ranked) top20Names.add(String(x.name).toLowerCase());
    } catch (_) {}

    const out = [];
    for (const w of waiters) {
      let display = `<@${w.userId}>`;
      try {
        const gm = interaction.guild?.members?.cache?.get(w.userId) || (interaction.guild ? await interaction.guild.members.fetch(w.userId) : null);
        if (gm) display = gm.nickname || gm.user?.username || display;
      } catch (_) {}
      let rating = 'N/A';
      let matchedName = '';
      if (rows.length && display) {
        const found = bestMatchPlayer(rows, display);
        if (found && found.row) {
          rating = found.row['Personal clan rating'] ?? found.row.rating ?? 'N/A';
          matchedName = String(found.row.Player || found.row.player || '');
        }
      }
      const numRating = toNumber(rating);
      const isLow = Number.isFinite(numRating) && numRating > 0 ? (numRating < threshold) : false;
      const isTop = matchedName ? top20Names.has(matchedName.toLowerCase()) : false;
      out.push({ name: display, seconds: w.seconds, rating: numRating, isLow, isTop });
    }

    // Sort by waiting longest first
    out.sort((a, b) => b.seconds - a.seconds);

    // Align columns: prefix (rank + name), duration, rating
    const rankWidth = String(out.length).length;
    const prefixes = out.map((x, i) => `${String(i + 1).padStart(rankWidth, ' ')}. ${x.name}`);
    const maxPrefix = prefixes.reduce((m, s) => Math.max(m, s.length), 0);
    const durations = out.map(x => formatDuration(x.seconds));
    const maxDur = durations.reduce((m, s) => Math.max(m, s.length), 0);
    const ratingStrs = out.map(x => String(x.rating));
    const ratingWidth = ratingStrs.reduce((m, s) => Math.max(m, s.length), 0);

    const lines = out.map((x, i) => {
      const prefix = prefixes[i];
      const dur = durations[i];
      const gap1 = ' '.repeat(maxPrefix - prefix.length);
      const durPad = ' '.repeat(maxDur - dur.length);
      const rating = String(x.rating).padStart(ratingWidth, ' ');
      const flags = `${x.isTop ? ' ⭐' : ''}${x.isLow ? ' ⚠️' : ''}`;
      return `${prefix}${gap1} — ${durPad}${dur} — ${rating}${flags}`;
    });
    const header = 'Waiting in voice channel:';
    const content = '```\n' + header + '\n\n' + lines.join('\n') + '\n```';
    await interaction.reply({ content });
  }
};
