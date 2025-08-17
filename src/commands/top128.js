// src/commands/top128.js
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');

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
  // Ensure we honor Discord's 2000 char limit per message
  const wrapper = { open: '```\n', close: '\n```' };
  const maxLen = 2000;
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
  },
  async execute(interaction) {
    const snap = readLatestSquadronSnapshot();
    const rows = (snap && snap.data && Array.isArray(snap.data.rows) && snap.data.rows.length)
      ? snap.data.rows
      : (Array.isArray(snap?.rows) ? snap.rows : []); // legacy fallback
    if (!snap || rows.length === 0) {
      await interaction.reply({ content: 'No squadron data available yet. Please try again later.', flags: MessageFlags.Ephemeral });
      return;
    }

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
    const prefixes = list.map((x, i) => `${String(i + 1).padStart(rankWidth, ' ')}. ${x.name}`);
    const maxPrefix = prefixes.reduce((m, s) => Math.max(m, s.length), 0);
    const ratingStrs = list.map(x => String(x.rating));
    const ratingWidth = ratingStrs.reduce((m, s) => Math.max(m, s.length), 0);

    const lines = [];
    const header = 'Top 128 by Personal clan rating:';
    lines.push(header, '');
    list.forEach((x, i) => {
      const prefix = prefixes[i];
      const gap = ' '.repeat(maxPrefix - prefix.length);
      const rating = String(x.rating).padStart(ratingWidth, ' ');
      lines.push(`${prefix}${gap} — ${rating}`);
    });

    const text = lines.join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `top128-${ts}.txt`;

    // Prefer sending as a file attachment to avoid message length limits
    try {
      await interaction.reply({
        content: 'Attached is the Top 128 list as a text file.',
        files: [{ attachment: Buffer.from(text, 'utf8'), name }],
      });
      return;
    } catch (_) {
      // Fallback: chunk into code blocks if file sending fails
      const blocks = chunkIntoCodeBlocks(text);
      if (blocks.length === 1) {
        await interaction.reply({ content: blocks[0] });
      } else {
        await interaction.reply({ content: blocks[0] });
        for (let i = 1; i < blocks.length; i++) {
          await interaction.followUp({ content: blocks[i] });
        }
      }
    }
  }
};
