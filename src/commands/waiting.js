// src/commands/waiting.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const waitingTracker = require('../waitingTracker');
const { bestMatchPlayer, toNumber } = require('../nameMatch');
const { getConfig: getLowPointsConfig } = require('../lowPointsIssuer');
const { formatTable, formatTableLight, ansiColour } = require('../utils/formatHelper');

const { sanitizeName } = require('../utils/nameSanitizer');

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

// Name matching and numeric parsing are centralized in ../nameMatch

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = {
  data: {
    name: 'waiting',
    description: 'Show members waiting in the configured voice channel with time and squadron rating',
  },
  async execute(interaction) {
    const waiters = waitingTracker.getWaiting();
    if (!Array.isArray(waiters) || waiters.length === 0) {
      await interaction.reply({ content: 'No one is currently waiting.', flags: MessageFlags.Ephemeral });
      return;
    }
    const snap = readLatestSquadronSnapshot();
    const rows = snap && snap.data && Array.isArray(snap.data.rows) ? snap.data.rows : [];
    const cfg = getLowPointsConfig ? getLowPointsConfig() : { threshold: 1300 };
    const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 1300;

    // Build Top 20 set from snapshot
    const top20Names = new Set();
    try {
      const ranked = rows
        .map(r => ({ r, rating: toNumber(r['Personal clan rating'] ?? r.rating), name: r.Player || r.player || '' }))
        .filter(x => x.name)
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 20);
      for (const x of ranked) top20Names.add(String(x.name).toLowerCase());
    } catch (error) { console.error('Error building top 20 names for waiting list:', error); }

    const out = [];
    for (const w of waiters) {
      let display = `<@${w.userId}>`;
      try {
        const gm = interaction.guild?.members?.cache?.get(w.userId) || (interaction.guild ? await interaction.guild.members.fetch(w.userId) : null);
        if (gm) {
          // Prefer per-server profile name (displayName), then global display name, then username
          const preferred = gm.displayName ?? gm.user?.globalName ?? gm.user?.username;
          if (preferred) display = sanitizeName(preferred);
        }
      } catch (error) { console.error('Error fetching guild member for waiting list:', error); }
      let rating = 'N/A';
      let matchedName = '';
      if (rows.length && display) {
        const found = bestMatchPlayer(rows, display);
        if (found && found.row) {
          rating = found.row['Personal clan rating'] ?? found.row.rating ?? 'N/A';
          matchedName = String(found.row.Player || found.row.player || '');
        }
      }
      const numRating = toNumber(rating);
      const isLow = Number.isFinite(numRating) && numRating > 0 ? (numRating < threshold) : false;
      const isTop = matchedName ? top20Names.has(matchedName.toLowerCase()) : false;
      out.push({ name: display, seconds: w.seconds, rating: numRating, isLow, isTop });
    }

    // Sort by waiting longest first
    out.sort((a, b) => b.seconds - a.seconds);

    const tableData = out.map((x, i) => {
      const contribution = x.isTop ? x.rating : Math.round(x.rating / 20);
      const flags = `${x.isTop ? ' ⭐' : ''}${x.isLow ? ' ⚠️' : ''}`;

      const obj = {
        pos: i + 1,
        name: x.name + flags,
        time: formatDuration(x.seconds),
        rating: x.rating,
        contribution: contribution
      };

      if (x.isTop) {
        const colour = 'yellow';
        obj.pos = String(obj.pos);
        obj.name = ansiColour(obj.name.replace(` ⭐`, '').replace(` ⚠️`, ''), colour);
        obj.time = obj.time;
        obj.rating = String(obj.rating);
        obj.contribution = String(obj.contribution);
      }

      if (x.isLow) {
        const colour = 'red';
        obj.pos = String(obj.pos);
        obj.name = ansiColour(obj.name.replace(` ⭐`, '').replace(` ⚠️`, ''), colour);
        obj.time = obj.time;
        obj.rating = String(obj.rating);
        obj.contribution = String(obj.contribution);
      }

      return obj;
    });

    const fieldHeaders = ["Pos", "Name", "Time", "Pts", "Cont"];
    const fieldOrder = ["pos", "name", "time", "rating", "contribution"];
    const text = formatTableLight(tableData, null, fieldHeaders, fieldOrder);

    const embed = new EmbedBuilder()
      .setTitle('Waiting List')
      .setDescription('```ansi\n' + text + '\n```')
      .setColor(0xd0463c)
      .setTimestamp(new Date());

    await interaction.reply({ embeds: [embed] });
  }
};
