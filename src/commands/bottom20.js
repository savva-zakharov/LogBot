// src/commands/bottom20.js
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');

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

function toNumber(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}

module.exports = {
  data: {
    name: 'bottom20',
    description: 'Show bottom 20 players by Personal clan rating from the latest snapshot',
  },
  async execute(interaction) {
    const snap = readLatestSquadronSnapshot();
    const rows = (snap && snap.data && Array.isArray(snap.data.rows) && snap.data.rows.length)
      ? snap.data.rows
      : (Array.isArray(snap?.rows) ? snap.rows : []); // legacy fallback
    if (!snap || rows.length === 0) {
      await interaction.reply({ content: 'No squadron data available yet. Please try again later.', flags: MessageFlags.Ephemeral });
      return;
    }

    // Sort rows by Personal clan rating asc
    const bottom = [...rows]
      .map(r => ({ r, rating: toNumber(r['Personal clan rating'] ?? r.rating), name: r.Player || r.player || 'Unknown' }))
      .sort((a, b) => a.rating - b.rating)
      .slice(0, 20);

    if (!bottom.length) {
      await interaction.reply({ content: 'Could not find any players with a Personal clan rating.', flags: MessageFlags.Ephemeral });
      return;
    }

    // Align columns: make ratings line up
    const rankWidth = String(bottom.length).length; // width for rank index
    const prefixes = bottom.map((x, i) => `${String(i + 1).padStart(rankWidth, ' ')}. ${x.name}`);
    const maxPrefix = prefixes.reduce((m, s) => Math.max(m, s.length), 0);
    const ratingStrs = bottom.map(x => String(x.rating));
    const ratingWidth = ratingStrs.reduce((m, s) => Math.max(m, s.length), 0);

    const lines = bottom.map((x, i) => {
      const prefix = prefixes[i];
      const gap = ' '.repeat(maxPrefix - prefix.length);
      const rating = String(x.rating).padStart(ratingWidth, ' ');
      return `${prefix}${gap} — ${rating}`;
    });

    const header = 'Bottom 20 by Personal clan rating:';

    const content = '```\n' + header + '\n\n' + lines.join('\n') + '\n```';
    await interaction.reply({ content });
  }
};
