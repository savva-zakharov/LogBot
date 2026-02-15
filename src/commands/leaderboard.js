// src/commands/leaderboard.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { loadSettings } = require('../config');
const { ansiColour, formatTable, formatTableLight, isNumeric } = require('../utils/formatHelper');

const useEmbed = true;
const useTable = true;
const embedColor = 0xd0463c;

function readLeaderboardData() {
  try {
    const file = path.join(process.cwd(), 'leaderboard_data.json');
    if (!fs.existsSync(file)) {
      return null;
    }
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : null;
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
    const leaderboard = readLeaderboardData();
    if (!leaderboard || !leaderboard.length) {
      await interaction.reply({ content: 'Leaderboard data is not available yet. Please try again later.', flags: MessageFlags.Ephemeral });
      return;
    }

    const settings = loadSettings();
    const primaryTag = Object.keys(settings.squadrons || {})[0] || '';

    const lines = [];
    const topCount = 20;
    const surroundingCount = 5;
    let primarySquadronIndex = -1;
    if (primaryTag) {
      primarySquadronIndex = leaderboard.findIndex(s => s.tag === primaryTag);
    }

    let displayData = [];
    if (primarySquadronIndex !== -1 && primarySquadronIndex >= topCount) {
      // Show top, then a separator, then squadrons around the primary one.
      displayData.push(...leaderboard.slice(0, topCount));
      displayData.push({ separator: true });
      const startIndex = Math.max(topCount, primarySquadronIndex - surroundingCount);
      const endIndex = Math.min(leaderboard.length, primarySquadronIndex + surroundingCount + 1);
      displayData.push(...leaderboard.slice(startIndex, endIndex));
    } else {
      // Show top N squadrons, or all if less than N
      displayData = leaderboard.slice(0, topCount);
    }

    //calculate the points change of each squadron
    for (const squadron of displayData) {
      squadron.change = squadron.points - squadron.pointsStart;

      if (squadron.change > 0) {
        squadron.change = ansiColour(`+${fmt(squadron.change)}`, 32);
      } else if (squadron.change < 0) {
        squadron.change = ansiColour(fmt(squadron.change), 31);
      } else {
        squadron.change = fmt(squadron.change);
      }
    }

    const maxPoints = Math.max(...displayData.map(d => fmt(d.points).length)) + 1;
    const maxChange = Math.max(...displayData.map(d => d.change.length)) + 1;
    let maxName = Math.max(...displayData.map(d => d.name.length)) + 1;

    const borders = 11 + maxPoints + maxChange;
    if (useEmbed && (borders + maxName > 56)) {
      maxName = 56 - borders;
    }

    let squadronPassed = false;
    for (const squadron of displayData) {
      squadron.tag = squadron.tag.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      squadron.points = fmt(squadron.points);
      delete squadron.pointsStart;
      squadron.pos = squadron.pos + 1;
      if (squadron.name.length > maxName) {
        squadron.name = squadron.name.slice(0, maxName - 2);
        squadron.name += '..';
      }
      squadron.name = squadron.name.padEnd(maxName, ' ');

      if (squadron.tag.includes(primaryTag)) {
        squadronPassed = true;
        squadron.tag = ansiColour(squadron.tag, 31);
        squadron.name = ansiColour(squadron.name, 31);
        squadron.pos = ansiColour(squadron.pos, 31);
        squadron.points = ansiColour(squadron.points, 31);
      } 
      else if (squadronPassed) {
        squadron.tag = ansiColour(squadron.tag, 30);
        squadron.name = ansiColour(squadron.name, 30);
        squadron.pos = ansiColour(squadron.pos, 30);
        squadron.points = ansiColour(squadron.points, 30);
      }
    }

    const fieldOrder = ["pos", "tag", "points", "change", "name"];
    const fieldHeaders = ["Pos", "Tag", "Points", "Δ", "Name"];
    const table = formatTable(displayData, null, fieldHeaders, fieldOrder);



    console.log(table);
    
    if (useEmbed) {
      const embed = new EmbedBuilder()
        .setTitle('Squadron Leaderboard')
        .setDescription('```ansi\n' + table + '\n```')
        .setColor(embedColor)
        .setTimestamp(new Date());

      await interaction.reply({ embeds: [embed] });    
    } else {
    await interaction.reply({ content: `\`\`\`ansi\n${table}\n\`\`\`` });
    }
  }
};


