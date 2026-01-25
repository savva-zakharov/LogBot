// src/commands/points.js
const fs = require('fs');
const path = require('path');
const { bestMatchPlayer } = require('../nameMatch');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { loadSettings } = require('../config');
const { formatTable, ansiColour } = require('../utils/formatHelper');
const { sanitizeName } = require('../utils/nameSanitizer');
const Fuse = require('fuse.js');

const useTable = true;
const useEmbed = false;
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



    const rows = (snap && snap.data && Array.isArray(snap.data.rows) && snap.data.rows.length)
      ? snap.data.rows
      : (Array.isArray(snap?.rows) ? snap.rows : []); // legacy fallback

    const top = [...rows]
      .map(r => ({ r, rating: toNumber(r['Personal clan rating'] ?? r.rating), name: sanitizeName(r.Player || r.player || 'Unknown') }))
      .sort((a, b) => b.rating - a.rating);

    top.forEach((row, index) => {
      row.position = index + 1;
      row.contribution = row.position < 20 ? row.rating : Math.round((row.rating / 20));
    });

    // const found = bestMatchPlayer(top.rows, targetName);
    // if (!found || !found.row) {
    //   await interaction.reply({ content: `Could not find a close match for \`${targetName || caller}\` in the latest squadron snapshot.`, flags: MessageFlags.Ephemeral });
    //   return;
    // } 

    const fuseOptions = {
      // isCaseSensitive: false,
      // includeScore: false,
      // ignoreDiacritics: false,
      // shouldSort: true,
      // includeMatches: false,
      // findAllMatches: false,
      // minMatchCharLength: 1,
      // location: 0,
      // threshold: 0.6,
      // distance: 100,
      // useExtendedSearch: false,
      // ignoreLocation: false,
      // ignoreFieldNorm: false,
      // fieldNormWeight: 1,
      keys: [
        "name"
      ]
    };
    console.log('Original target name:', targetName);
    const sanitizedTargetName = sanitizeName(targetName.replace(/\([^)]*\)/g, ''));
    console.log('Sanitized target name:', sanitizedTargetName);
    const found = new Fuse(top, fuseOptions).search(sanitizedTargetName)[0];
    console.log('Found:', found);




    const row = found.item;
    const rating = row['Personal clan rating'] ?? row.rating ?? 'N/A';
    const playerName = row.name || 'Unknown player';
    const contribution = row.contribution;

    if (useEmbed) {

      const embed = new EmbedBuilder()
        .setTitle(`Personal clan rating for ${playerName}`)
        .setDescription(`Personal clan rating: ${rating}\nContribution: ${contribution}`)
        .setColor(embedColor)
        .setTimestamp(new Date());

      await interaction.reply({ embeds: [embed] });

    } else {
      let header = `Player        : ${playerName}\nPoints        : ${rating}\nContribution  : ${contribution}`;
      if (typeof snap.totalPoints === 'number') {
        header += `\nSquadron total: ${snap.totalPoints}`;
      }
      await interaction.reply({ content: '```\n' + header + '\n```' });
    }

  }
};


function toNumber(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}
