// src/commands/top20.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { loadSettings } = require('../config');
const { formatTable, ansiColour } = require('../utils/formatHelper');

const { sanitizeName } = require('../utils/nameSanitizer');

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
    name: 'top20',
    description: 'Show top 20 players by Personal clan rating from the latest snapshot',
  },
  async execute(interaction) {
    const settings = loadSettings();
    const primaryTag = Object.keys(settings.squadrons || {})[0] || '';

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
      .map(r => ({ r, rating: toNumber(r['Personal clan rating'] ?? r.rating), name: sanitizeName(r.Player || r.player || 'Unknown') }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 20);

    if (!top.length) {
      await interaction.reply({ content: 'Could not find any players with a Personal clan rating.', flags: MessageFlags.Ephemeral });
      return;
    }

    const tableData = top.map((x, i) => ({
      pos: ansiColour(String(i + 1), 33),
      name: ansiColour(x.name, 33),
      rating: ansiColour(String(x.rating), 33)
    }));

    const titleText = 'Top 20 Players in ' + primaryTag;
    const fieldHeaders = ["Pos", "Name", "Points"];
    const fieldOrder = ["pos", "name", "rating"];
    const text = formatTable(tableData, titleText, fieldHeaders, fieldOrder);

    const embed = new EmbedBuilder()
      .setTitle(titleText)
      .setDescription('```ansi\n' + text + '\n```')
      .setColor(0xd0463c)
      .setTimestamp(new Date());

    await interaction.reply({ embeds: [embed] });
  }
};
