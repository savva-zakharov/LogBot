// src/commands/timeleaderboard.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { formatTable, sanitizeUsername } = require('../utils/formatHelper');

const embedColor = 0x3498db; // A nice blue

function loadWaitingTimes() {
  const file = path.join(process.cwd(), 'waiting_times.json');
  if (!fs.existsSync(file)) return { players: {} };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : { players: {} };
  } catch (_) {
    return { players: {} };
  }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function chunkIntoCodeBlocks(text) {
  const wrapper = { open: '```ansi\n', close: '\n```' };
  const maxLen = 1000;
  const contentMax = maxLen - (wrapper.open.length + wrapper.close.length);
  const lines = text.split('\n');
  const blocks = [];
  let current = '';
  for (const line of lines) {
    const candidate = (current ? current + '\n' : '') + line;
    if (candidate.length > contentMax) {
      blocks.push(wrapper.open + current + wrapper.close);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) blocks.push(wrapper.open + current + wrapper.close);
  return blocks;
}

module.exports = {
  data: {
    name: 'timeleaderboard',
    description: 'Leaderboard of total tracked time for all members',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'file',
        description: 'Send the list as a file attachment',
      },
      {
        type: 1,
        name: 'embed',
        description: 'Send the list as an embed',
      }
    ],
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand(false) || 'embed';
    const data = loadWaitingTimes();
    if (!data.players || Object.keys(data.players).length === 0) {
      await interaction.reply({ content: 'No tracked time data available yet.', flags: MessageFlags.Ephemeral });
      return;
    }

    // Identify all unique categories across all players
    const categorySet = new Set();
    Object.values(data.players).forEach(p => {
      if (p.time) Object.keys(p.time).forEach(cat => categorySet.add(cat));
    });
    const categories = Array.from(categorySet).sort();

    const list = Object.entries(data.players).map(([userId, p]) => {
      const totalSeconds = Object.values(p.time || {}).reduce((a, b) => a + b, 0);
      return {
        userId,
        name: p.gameName || p.discordName || 'Unknown',
        totalSeconds,
        timeBreakdown: p.time || {}
      };
    })
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, 128);

    const tableData = list.map((x, i) => {
      const row = {
        pos: i + 1,
        name: sanitizeUsername(x.name).slice(0, 15),
        total: formatDuration(x.totalSeconds)
      };
      // Add each category column
      categories.forEach(cat => {
        const sec = x.timeBreakdown[cat] || 0;
        row[cat] = sec > 0 ? formatDuration(sec) : '-';
      });
      return row;
    });

    const fieldHeaders = ["Pos", "Name", "Total", ...categories];
    const fieldOrder = ["pos", "name", "total", ...categories];
    const text = formatTable(tableData, "Time Leaderboard", fieldHeaders, fieldOrder, false);

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `timeleaderboard-${ts}.txt`;

    if (sub === 'file') {
      try {
        await interaction.reply({
          content: 'Attached is the Time Leaderboard as a text file.',
          files: [{ attachment: Buffer.from(text, 'utf8'), name: filename }],
        });
      } catch (e) {
        console.error('Failed to send Time Leaderboard file:', e);
        await interaction.reply({ content: 'Failed to send file.', flags: MessageFlags.Ephemeral });
      }
    } else {
      try {
        if (text.length < 4000) {
          const embed = new EmbedBuilder()
            .setTitle('Time Leaderboard')
            .setDescription('```ansi\n' + text + '\n```')
            .setColor(embedColor)
            .setTimestamp(new Date());

          await interaction.reply({ embeds: [embed] });
        } else {
          const blocks = chunkIntoCodeBlocks(text);
          const fields = blocks.map((block, i) => ({ name: `${i + 1}/${blocks.length}`, value: block }));
          const embed = new EmbedBuilder()
            .setTitle('Time Leaderboard')
            .setColor(embedColor)
            .setTimestamp(new Date())
            .addFields(fields);
          await interaction.reply({ embeds: [embed] });
        }
      } catch (e) {
        console.error('Failed to send Time Leaderboard:', e);
        await interaction.reply({ content: 'Failed to send leaderboard.', flags: MessageFlags.Ephemeral });
      }
    }
  }
};
