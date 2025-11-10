// src/commands/leaderboard.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { loadSettings } = require('../config');
const { makeSeparator, makeStarter, makeCloser, padCenter, ansiColour, makeTitle } = require('../utils/formatHelper');

const useEmbed = false;

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

    for (const squadron of displayData) {
      if (squadron.separator) {
        lines.push('...');
        continue;
      }

      let nameLength = 24;
      if (useEmbed) {
        nameLength = 30;
      }
      const rank = (squadron.pos + 1).toString().padStart(3, ' ');
      const tag = padCenter(squadron.tag.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''), 5, ' ');
      const points = fmt(squadron.points).padEnd(6, ' ');
      const name = squadron.name.slice(0, nameLength).padEnd(nameLength, ' ');
      let change = fmt(squadron.points - squadron.pointsStart);
  

      // let line = `${rank} | ${tag} | ${points} | ${change} | ${name}`;

      //highlight the change if it is positive or negative
      let line = '';

      if (primaryTag && squadron.tag.includes(primaryTag)) {
        line = `│${ansiColour(rank, 33, true)} │ ${ansiColour(tag, 33, true)} │ ${ansiColour(points, 33, true)} │ `;
      } else {
        line = `│${rank} │ ${tag} │ ${points} │ `;
      }
      
      if (change > 0) {
        change = `+${change}`;
        change = change.padStart(4, ' ');
        line += ansiColour(change, 32, false);
      } else if (change < 0) {
        change = change.padStart(4, ' ');
        line += ansiColour(change, 31, false);
      } else {
        change = change.padStart(4, ' ');
        line += change;
      }
      
      if (primaryTag && squadron.tag.includes(primaryTag)) {
        line += ` │ ${ansiColour(name, 33, true)}│`;
      } else {
        line += ` │ ${name}│`;
      }

      lines.push(line);
    }

    const header =    '│ No.│  Tag  │ Points │    Δ │ Name                    │';
    let title = makeTitle('Squadron Leaderboard', header);
    let separator = makeSeparator(header);
    let closer = makeCloser(header);

    const body = [title, header, separator, ...lines, closer].join('\n');


    if (useEmbed) {
    const embed = new EmbedBuilder()
      .setTitle('Squadron Leaderboard')
      .setDescription('```ansi\n' + body + '\n```')
      .setColor(0x57F287)
      .setTimestamp(new Date());

    await interaction.reply({ embeds: [embed] });
    } else {
      await interaction.reply({ content: `\`\`\`ansi\n${body}\n\`\`\`` });
    }
  }
};

