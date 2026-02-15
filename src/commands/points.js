// src/commands/points.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { formatTable, ansiColour } = require('../utils/formatHelper');
const { getConfig: getLowPointsConfig } = require('../lowPointsIssuer');
const { fuseMatch, toNumber } = require('../nameMatch');

const useTable = true;
const useEmbed = true;
const embedColor = 0xd0463c;

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
    description: 'Show a player\'s Personal clan points (defaults to you) from the latest snapshot',
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
    
    const cfg = getLowPointsConfig ? getLowPointsConfig() : { threshold: 1300 };
    const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 1300;
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

    const rows = (snap && snap.data && Array.isArray(snap.data.rows) && snap.data.rows.length)
      ? snap.data.rows
      : (Array.isArray(snap?.rows) ? snap.rows : []); // legacy fallback

    const top = [...rows]
      .map(r => ({ r, points: toNumber(r['Points'] ?? r.points), name: (r.Player || r.player || 'Unknown'), pointsStart: toNumber(r['PointsStart'] ?? r.pointsStart) || NaN }))
      .sort((a, b) => b.points - a.points);

    top.forEach((row, index) => {
      row.position = index + 1;
      row.contribution = row.position < 20 ? row.points : Math.round((row.points / 20));
    });

    const found = fuseMatch(top, targetName);

    if (!found || !found.item) {
      await interaction.reply({ content: `Could not find a close match for \`${targetName || caller}\` in the latest squadron snapshot.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const row = found.item;
    const points = row.points;
    const pointsStart = row.pointsStart;
    const pointsDelta = points - pointsStart;
    const playerName = row.name || 'Unknown player';
    const contribution = row.contribution;
    const contributionPercent = Math.round(contribution / snap.totalPoints * 10000) / 100 + '%';
    let body = ``;

    if (useTable) {
      let displayData = [];
        displayData.push({
          // name: playerName,
          points: row.points < threshold ? ansiColour(row.points, 'red') : row.points,
          delta: pointsDelta < 0 ? ansiColour(pointsDelta, 'red') : pointsDelta > 0 ? ansiColour(pointsDelta, 'green') : pointsDelta,
          position: row.position < 21 ? ansiColour(row.position, 'cyan') : row.position,
          contribution: contribution,
          contributionPercent: contributionPercent
        });

        const fieldOrder = ["position", "points", "delta", "contribution", "contributionPercent"];
        const fieldHeaders = ["Pos.", "Points", "Δ", "Contribution", "%"];
        body = formatTable(displayData, playerName, fieldHeaders, fieldOrder);
    } else {
      body = `Points: ${points}\nPosition: ${row.position}\nContribution: ${contribution} (${contributionPercent})`;
    }

    if (useEmbed) {

      const embed = new EmbedBuilder()
        .setTitle(playerName)
        .setDescription(`\`\`\`ansi\n${body}\`\`\``)
        .setColor(embedColor)
        .setTimestamp(new Date());

      await interaction.reply({ embeds: [embed] });

    } else {
      let header = `Player        : ${playerName}\nPoints        : ${points}\nContribution  : ${contribution} (${contributionPercent})`;
      if (typeof snap.totalPoints === 'number') {
        header += `\nSquadron total: ${snap.totalPoints}`;
      }
      await interaction.reply({ content: '```\n' + header + '\n```' });
    }

  }
};