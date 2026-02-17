// src/commands/leaderboard.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { loadSettings } = require('../config');
const { getConfig: getLowPointsConfig } = require('../lowPointsIssuer');
const { getSession } = require('../tracker');
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

    const topCount = 20;
    const surroundingCount = 3;
    let primarySquadronIndex = -1;

    const primaryTag = Object.keys(settings.squadrons || {})[0] || '';
    const needle = primaryTag.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();

    const squadronInfo = leaderboard.find(s => {
      const stag = String(s.tagl || s.tag || '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
      primarySquadronIndex = leaderboard.indexOf(s);
      return stag === needle;
    });


    console.log('[DEBUG] Primary squadron index:', primarySquadronIndex, 'Primary tag:', primaryTag, 'Squadron info:', squadronInfo);
    console.log('[DEBUG] type:', typeof leaderboard);

    console.log('[DEBUG] leaderboard:', leaderboard);
    console.log('[DEBUG] isArray:', Array.isArray(leaderboard));
    console.log('[DEBUG] length:', leaderboard?.length);


    let displayData = [];
    try {
      if (primarySquadronIndex !== -1 && primarySquadronIndex >= topCount) {
        // Show top, then a separator, then squadrons around the primary one.
        displayData.push(...leaderboard.slice(0, topCount));
        displayData.push({ 
          name: "·".repeat(leaderboard[topCount - 1].name.length),
          tag: "·".repeat(5), 
          points: "·".repeat(leaderboard[topCount - 1].points.toString().length), 
          pointsStart: "·".repeat(leaderboard[topCount - 1].pointsStart.toString().length), 
          pos: " ", 
          separator: true 
        });
        const startIndex = Math.max(topCount, primarySquadronIndex - surroundingCount);
        const endIndex = Math.min(leaderboard.length, primarySquadronIndex + surroundingCount + 1);
        displayData.push(...leaderboard.slice(startIndex, endIndex));
      } else {
        // Show top N squadrons, or all if less than N
        displayData = leaderboard.slice(0, topCount);
      }
    } catch (error) {
      console.error('[ERROR] Failed to process leaderboard data:', error);
      await interaction.reply({ content: 'An error occurred while processing the leaderboard data. Please try again later.', flags: MessageFlags.Ephemeral });
      return;
    }

    //calculate the points change of each squadron
    for (const squadron of displayData) {
      squadron.change = squadron.points - squadron.pointsStart;
      if (squadron.separator) {
        squadron.change = ' ';
      } else if (squadron.change > 0) {
        squadron.change = ansiColour(`+${fmt(squadron.change)}`, 32);
      } else if (squadron.change < 0) {
        squadron.change = ansiColour(fmt(squadron.change), 31);
      } else {
        squadron.change = fmt(squadron.change);
      }
    }

    let maxPointsLength = 0;
    let maxChangeLength = 0;
    let maxNameLength = 0;

    try {
      for (const squadron of displayData) {
        if (squadron.separator) continue;
        
        maxPointsLength = Math.max(maxPointsLength, fmt(squadron.points).length);
        maxChangeLength = Math.max(maxChangeLength, squadron.change.length);
        maxNameLength = Math.max(maxNameLength, squadron.name.length);
      }
    } catch (error) {
      console.error('[ERROR] Failed to calculate max lengths:', error);
      await interaction.reply({ content: 'An error occurred while processing the leaderboard data. Please try again later.', flags: MessageFlags.Ephemeral });
      return;
    }


    const maxPoints = maxPointsLength + 1;
    const maxChange = maxChangeLength + 1;
    let maxName = maxNameLength + 1;

    const borders = 11 + maxPoints + maxChange;
    if (useEmbed && (borders + maxName > 56)) {
      maxName = 56 - borders;
    }

    let squadronPassed = false;
    for (const squadron of displayData) {
      if (squadron.separator) continue;
      
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
        squadron.tag = ansiColour(squadron.tag, "red");
        squadron.name = ansiColour(squadron.name, "red");
        squadron.pos = ansiColour(squadron.pos, "red");
        squadron.points = ansiColour(squadron.points, "red");
      }
      else if (squadronPassed) {
        squadron.tag = ansiColour(squadron.tag, "gray");
        squadron.name = ansiColour(squadron.name, "gray");
        squadron.pos = ansiColour(squadron.pos, "gray");
        squadron.points = ansiColour(squadron.points, "gray");
      }
    }

    const fieldOrder = ["pos", "tag", "points", "change", "name"];
    const fieldHeaders = ["Pos", "Tag", "Points", "Δ", "Name"];
    
    // Get session stamp for header (e.g., "2026-02-17 | EU")
    let sessionStamp = null;
    try {
      const session = getSession();
      if (session && session.windowKey) {
        // Format: "YYYY-MM-DD | EU" or "YYYY-MM-DD | US"
        sessionStamp = session.windowKey.replace(/\|/g, ' | ');
      } else if (session && session.isCompleted && session.windowKey) {
        // Use last completed session if current is not active
        sessionStamp = session.windowKey.replace(/\|/g, ' | ');
      }
    } catch (e) {
      console.warn('[leaderboard] Failed to get session for header:', e.message);
    }
    
    const table = formatTable(displayData, sessionStamp, fieldHeaders, fieldOrder);



    // console.log(table);

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


