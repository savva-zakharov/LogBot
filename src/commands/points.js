// src/commands/points.js
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');
const { bestMatchPlayer } = require('../nameMatch');

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

// Matching logic is centralized in ../nameMatch

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
    if (typeof snap.totalPoints === 'number') {
      header += `\nSquadron total: ${snap.totalPoints}`;
    }

    await interaction.reply({ content: '```\n' + header + '\n```' });
  }
};
