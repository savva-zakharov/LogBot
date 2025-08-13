// src/commands/top20.js
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

function toNumber(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}

module.exports = {
  data: {
    name: 'top20',
    description: 'Show top 20 players by Personal clan rating from the latest snapshot',
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

    // Sort rows by Personal clan rating desc
    const top = [...rows]
      .map(r => ({ r, rating: toNumber(r['Personal clan rating'] ?? r.rating), name: r.Player || r.player || 'Unknown' }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 20);

    if (!top.length) {
      await interaction.reply({ content: 'Could not find any players with a Personal clan rating.', flags: MessageFlags.Ephemeral });
      return;
    }

    // Align columns: make ratings line up
    const rankWidth = String(top.length).length; // width for rank index
    const prefixes = top.map((x, i) => `${String(i + 1).padStart(rankWidth, ' ')}. ${x.name}`);
    const maxPrefix = prefixes.reduce((m, s) => Math.max(m, s.length), 0);
    const ratingStrs = top.map(x => String(x.rating));
    const ratingWidth = ratingStrs.reduce((m, s) => Math.max(m, s.length), 0);

    const lines = top.map((x, i) => {
      const prefix = prefixes[i];
      const gap = ' '.repeat(maxPrefix - prefix.length);
      const rating = String(x.rating).padStart(ratingWidth, ' ');
      return `${prefix}${gap} — ${rating}`;
    });

    const header = 'Top 20 by Personal clan rating:';

    const content = '```\n' + header + '\n\n' + lines.join('\n') + '\n```';
    await interaction.reply({ content });
  }
};
