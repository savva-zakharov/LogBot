// src/commands/times.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { fuseMatch } = require('../nameMatch');
const { formatTableLight, ansiColour } = require('../utils/formatHelper');

function loadWaitingTimes() {
  const file = path.join(process.cwd(), 'waiting_times.json');
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

module.exports = {
  data: {
    name: 'times',
    description: 'Get recorded voice channel times for a player',
    options: [
      {
        name: 'player',
        type: 3, // STRING
        description: 'Player name, nickname, or Discord User ID (defaults to yourself)',
        required: false,
      },
    ],
  },
  async execute(interaction) {
    const playerOption = interaction.options.getString('player');
    const input = playerOption ? playerOption.trim() : interaction.user.id;
    const data = loadWaitingTimes();
    const players = data.players || {};

    let targetPlayer = null;
    let userId = null;

    // 1. Direct ID match
    if (/^\d{17,19}$/.test(input)) {
      if (players[input]) {
        targetPlayer = players[input];
        userId = input;
      }
    }

    // 2. Fuzzy match if no direct ID match
    if (!targetPlayer) {
      const candidates = Object.entries(players).map(([id, p]) => ({
        id,
        discordName: p.discordName || '',
        gameName: p.gameName || '',
        // Combine names for better fuzzy search coverage
        searchName: `${p.discordName} ${p.gameName}`.trim()
      }));

      if (candidates.length > 0) {
        const found = fuseMatch(candidates, input, ['discordName', 'gameName', 'searchName']);
        if (found && found.item) {
          userId = found.item.id;
          targetPlayer = players[userId];
        }
      }
    }

    if (!targetPlayer) {
      await interaction.reply({ 
        content: `Could not find any recorded times for "${input}".`, 
        flags: MessageFlags.Ephemeral 
      });
      return;
    }

    const timeData = targetPlayer.time || {};
    const tracks = Object.entries(timeData);

    if (tracks.length === 0) {
      await interaction.reply({ 
        content: `No voice channel times recorded for **${targetPlayer.discordName || targetPlayer.gameName || userId}**.`, 
        flags: MessageFlags.Ephemeral 
      });
      return;
    }

    // Prepare table data
    const tableRows = tracks.map(([track, seconds]) => ({
      track: track,
      duration: formatDuration(seconds)
    }));

    // Sort by longest time
    tableRows.sort((a, b) => {
        const getSec = (dur) => {
            const parts = dur.match(/(\d+)h|(\d+)m|(\d+)s/g);
            let total = 0;
            if (!parts) return 0;
            parts.forEach(p => {
                if (p.includes('h')) total += parseInt(p) * 3600;
                if (p.includes('m')) total += parseInt(p) * 60;
                if (p.includes('s')) total += parseInt(p);
            });
            return total;
        };
        return getSec(b.duration) - getSec(a.duration);
    });

    const headers = ["Channel/Mask", "Time"];
    const order = ["track", "duration"];
    const tableText = formatTableLight(tableRows, null, headers, order);

    const embed = new EmbedBuilder()
      .setTitle(`Voice Activity: ${targetPlayer.discordName || targetPlayer.gameName || 'Unknown'}`)
      .setDescription('```ansi\n' + tableText + '\n```')
      .addFields(
        { name: 'Discord ID', value: userId, inline: true },
        { name: 'Game Name', value: targetPlayer.gameName || 'Not linked', inline: true }
      )
      .setColor(0x5865F2) // Discord Blurple
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
};
