// src/commands/top128.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { makeSeparator, makeStarter, makeCloser, padCenter, formatTable, ansiColour, makeTitle, sanitizeUsername } = require('../utils/formatHelper');
const { getConfig: getLowPointsConfig } = require('../lowPointsIssuer');

const useEmbed = true;
const useTable = true;
const showContribution = false;
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

function toNumber(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}

function chunkIntoCodeBlocks(text) {
  // Ensure we honor Discord's 2000 char limit per message or 1000 limit per embed
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
    name: 'top128',
    description: 'List up to 128 members by personal clan rating from the latest snapshot',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'file',
        description: 'Send the list as a file attachment',
        required: false,
      },
      {
        type: 1,
        name: 'embed',
        description: 'Send the list as an embed',
        required: false,
      }
    ],
  },


  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const snap = readLatestSquadronSnapshot();
    const rows = (snap && snap.data && Array.isArray(snap.data.rows) && snap.data.rows.length)
      ? snap.data.rows
      : (Array.isArray(snap?.rows) ? snap.rows : []); // legacy fallback
    if (!snap || rows.length === 0) {
      await interaction.reply({ content: 'No squadron data available yet. Please try again later.', flags: MessageFlags.Ephemeral });
      return;
    }
    
    const cfg = getLowPointsConfig ? getLowPointsConfig() : { threshold: 1300 };

    // Sort rows by Personal clan rating desc
    const list = [...rows]
      .map(r => ({ r, rating: toNumber(r['Personal clan rating'] ?? r.rating), name: r.Player || r.player || 'Unknown' }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 128);

    if (!list.length) {
      await interaction.reply({ content: 'Could not find any players with a Personal clan rating.', flags: MessageFlags.Ephemeral });
      return;
    }



    // Align columns: make ratings line up
    const rankWidth = String(list.length).length; // width for rank index (up to 3)
    const prefixes = list.map((x, i) => `${String(i + 1).padStart(rankWidth, ' ')}. ${x.name.replace(/[^\x20-\x7E]/g, "")}`);
    const maxPrefix = prefixes.reduce((m, s) => Math.max(m, s.length), 0);
    const ratingStrs = list.map(x => String(x.rating));
    const ratingWidth = ratingStrs.reduce((m, s) => Math.max(m, s.length), 0);

    const lines = [];

    if (useTable) {
      list.forEach((x, i) => {
        
        const maxNameLength = (showContribution ? 16 : 20);
        const isTop20 = i < 20;
        const isLowPoint = x.rating < cfg.threshold;
        const contribution = isTop20 ? x.rating : Math.round(x.rating / 20);
        const obj = {
          pos: i + 1,
          name: sanitizeUsername(x.name).slice(0, maxNameLength),
          rating: x.rating,
          contribution: showContribution ? contribution : null
        };

        // if (isTop20) {
        //   obj.pos = String(obj.pos);
        //   obj.name = ansiColour(obj.name.slice(0, maxNameLength), 31, true); //colour top 20 red
        //   obj.rating = String(obj.rating);
        //   if (showContribution) {
        //     obj.contribution = String(obj.contribution);
        //   }
        // }else if (isLowPoint) {
        //   obj.pos = String(obj.pos);
        //   obj.name = ansiColour(obj.name.slice(0, maxNameLength), 30, true); //colour low points gray
        //   obj.rating = String(obj.rating);
        //   if (showContribution) {
        //     obj.contribution = String(obj.contribution);
        //   }
        // }
        lines.push(obj);
      });
    } else {

      const header = `No. ` + String('Name').padEnd(maxPrefix - 4, ' ') + ' -Points-Contribution';
      lines.push(header);
      list.forEach((x, i) => {
        const prefix = prefixes[i];
        const gap = ' '.repeat(maxPrefix - prefix.length);
        const rating = String(x.rating).padStart(ratingWidth, ' ');
        let contribution = '';
        if (i < 20) {
          contribution = String(x.rating).padStart(ratingWidth, ' ');
          //top 20 get coloured red
          lines.push(ansiColour(`${prefix}${gap} - ${rating} - ${contribution}`, 33));
        } else {
          //everyone else get gray
          contribution = String(Math.round(x.rating / 20)).padStart(ratingWidth, ' ');
          lines.push(`${prefix}${gap} - ${rating} - ${contribution}`);
        }

      });
    }

    let text;

    if (useTable) {
      const fieldHeaders = showContribution ? ["Pos", "Name", "Pts", "Cont"] : ["Pos", "Name", "Pts"];
      const fieldOrder = showContribution ? ["pos", "name", "rating", "contribution"] : ["pos", "name", "rating"];
      text = formatTable(lines, null, fieldHeaders, fieldOrder, false);
    } else {
      text = lines.join('\n');
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `top128-${ts}.txt`;

    const file = interaction.options.getBoolean('file');

    if (sub === 'file') {
      try {
        await interaction.reply({
          content: 'Attached is the Top 128 list as a text file.',
          files: [{ attachment: Buffer.from(text, 'utf8'), name }],
        });
      } catch (_) {
        console.error('Failed to send Top 128 list:', _);
      }
    } else if (sub === 'embed') {
      try {
        // Fallback: chunk into code blocks if file sending fails
        let blocks;
        if (text.length < 4000) {
          const embed = new EmbedBuilder()
            .setTitle('Top 128')
            .setDescription('```ansi\n' + text + '\n```')
            .setColor(embedColor)
            .setTimestamp(new Date());

          await interaction.reply({ embeds: [embed] });
        } else {
          blocks = chunkIntoCodeBlocks(text);
        } 

        if (blocks.length === 1) {
          const embed = new EmbedBuilder()
            .setTitle('Top 128')
            .setDescription('```ansi\n' + blocks[0] + '\n```')
            .setColor(embedColor)
            .setTimestamp(new Date());

          await interaction.reply({ embeds: [embed] });
        } else {
          const fields = blocks.map((block, i) => ({ name: `${i + 1}/${blocks.length}`, value: block }));
          const embed = new EmbedBuilder()
            .setTitle('Top 128')
            .setColor(embedColor)
            .setTimestamp(new Date())
            .addFields(fields)
            ;
          await interaction.reply({ embeds: [embed] });
        }
      } catch (_) {
        console.error('Failed to send Top 128 list:', _);
      }
    }
  }
};
