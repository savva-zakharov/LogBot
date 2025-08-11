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
    if (!snap || !snap.data || !Array.isArray(snap.data.rows) || snap.data.rows.length === 0) {
      await interaction.reply({ content: 'No squadron data available yet. Please try again later.', flags: MessageFlags.Ephemeral });
      return;
    }

    // Sort rows by Personal clan rating desc
    const rows = [...snap.data.rows]
      .map(r => ({ r, rating: toNumber(r['Personal clan rating'] ?? r.rating), name: r.Player || r.player || 'Unknown' }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 20);

    if (!rows.length) {
      await interaction.reply({ content: 'Could not find any players with a Personal clan rating.', flags: MessageFlags.Ephemeral });
      return;
    }

    const lines = rows.map((x, i) => `${String(i + 1).padStart(2, ' ')}. ${x.name} — ${x.rating}`);

    let header = 'Top 20 by Personal clan rating:';

    const content = '```\n' + header + '\n\n' + lines.join('\n') + '\n```';
    await interaction.reply({ content });
  }
};
