// src/commands/top20.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { loadSettings } = require('../config');
const { makeSeparator, makeStarter, makeCloser, padCenter, ansiColour, makeTitle } = require('../utils/formatHelper');

const useEmbed = true;
const useTable = true;

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

const { sanitizeName } = require('../utils/nameSanitizer');

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

    // Align columns: make ratings line up
    const rankWidth = String(top.length).length; // width for rank index
    const ranks = top.map((x, i) => `${String(i + 1).padStart(rankWidth, ' ')}`);
    const names = top.map(x => String(x.name));
    const maxName = names.reduce((m, s) => Math.max(m, s.length), 0);

    let lines = [];

    if (useTable) {
      lines = top.map((x, i) => {
        const prefix = ranks[i];
        const name = names[i];
        const rating = String(x.rating);
        return `│ ${prefix} │ ${name.padEnd(maxName+1, ' ')}│ ${rating.padStart(6, ' ')} │`;
      });
    } else {
      lines = top.map((x, i) => {
        const prefix = ranks[i];
        const name = names[i];
        const rating = String(x.rating);
        return `${prefix}. ${name.padEnd(maxName+1, ' ')}— ${rating.padStart(4, ' ')}`;
      });
    }

    const titleText = 'Top 20 Players in ' + primaryTag + ':';


    if (useTable) {
      

      const header = '│ No.│ ' + 'Name'.padEnd(maxName+1, ' ') + '│ Points │';
      let title = makeTitle(titleText, header);
      let starter = makeStarter(header);
      let separator = makeSeparator(header);
      let closer = makeCloser(header);

      if (useEmbed) {
        const content = '```\n' + [starter, header, separator, ...lines, closer].join('\n') + '\n```';
        const embed = new EmbedBuilder()
          .setTitle(titleText)
          .setDescription(content)
          .setColor(0xd0463c)
          .setTimestamp(new Date());
        await interaction.reply({ embeds: [embed] });
      } else {
        const content = '```\n' + [title, header, separator, ...lines, closer].join('\n') + '\n```';
        await interaction.reply({ content });
      }
    } else {
      if (useEmbed) {
        const embed = new EmbedBuilder()
          .setTitle(titleText)
          .setDescription('```ansi\n' + lines.join('\n') + '\n```')
          .setColor(0xd0463c)
          .setTimestamp(new Date());
        await interaction.reply({ embeds: [embed] });
      } else {
        const content = '```\n' + titleText + '\n\n' + lines.join('\n') + '\n```';
        await interaction.reply({ content });
      }
    }

  }
};
