// src/commands/leaderboard.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { loadSettings } = require('../config');

function readLatestSnapshot() {
  try {
    const file = path.join(process.cwd(), 'squadron_data.json');
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && Object.keys(obj).length ? obj : null;
  } catch (_) { return null; }
}

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-GB');
}

module.exports = {
  data: {
    name: 'leaderboard',
    description: 'Show the current squadron leaderboard',
  },
  async execute(interaction) {
    const snap = readLatestSnapshot();
    if (!snap || !snap.data || !snap.data.leaderboard || !snap.data.leaderboard.length) {
      await interaction.reply({ content: 'Leaderboard data is not available yet. Please try again later.', flags: MessageFlags.Ephemeral });
      return;
    }

    const settings = loadSettings();
    const primaryTag = Object.keys(settings.squadrons || {})[0] || '';

    const lines = [];
    for (let i = 0; i < snap.data.leaderboard.length; i++) {
      const squadron = snap.data.leaderboard[i];
      const rank = (i + 1).toString().padStart(4, ' ');
      const tag = squadron.tag.padEnd(8, ' ');
      const points = fmt(squadron.points).padEnd(10, ' ');
      const name = squadron.name;

      let line = `${rank} | ${tag} | ${points} | ${name}`;
      if (primaryTag && squadron.tag === primaryTag) {
        line = `\u001b[1;33m${line}\u001b[0m`;
      } else if (rank < 6) {
        line = `\u001b[1;31m${line}\u001b[0m`;
      }
      lines.push(line);
    }

    const header = 'Rank | Tag      | Points     | Name';
    const separator = '-'.repeat(header.length + 5);
    const body = [header, separator, ...lines].join('\n');

    const embed = new EmbedBuilder()
      .setTitle('Squadron Leaderboard')
      .setDescription('```ansi\n' + body + '\n```')
      .setColor(0x57F287)
      .setTimestamp(new Date(snap.ts || Date.now()));

    await interaction.reply({ embeds: [embed] });
  }
};