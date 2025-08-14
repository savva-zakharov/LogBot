// src/commands/rank.js
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');

function readLatestSnapshot() {
  try {
    const file = path.join(process.cwd(), 'squadron_data.json');
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    const arr = Array.isArray(obj.squadronSnapshots) ? obj.squadronSnapshots : [];
    return arr.length ? arr[arr.length - 1] : null;
  } catch (_) { return null; }
}

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-GB');
}

module.exports = {
  data: {
    name: 'rank',
    description: 'Show current squadron rank and point gaps to neighbors (from latest snapshot)',
  },
  async execute(interaction) {
    const snap = readLatestSnapshot();
    if (!snap) {
      await interaction.reply({ content: 'No data yet. Please try again later.', flags: MessageFlags.Ephemeral });
      return;
    }
    const place = snap.squadronPlace ?? null;
    const ours = (typeof snap.totalPoints === 'number' && Number.isFinite(snap.totalPoints)) ? snap.totalPoints : null;
    const above = (typeof snap.totalPointsAbove === 'number' && Number.isFinite(snap.totalPointsAbove)) ? snap.totalPointsAbove : null;
    const below = (typeof snap.totalPointsBelow === 'number' && Number.isFinite(snap.totalPointsBelow)) ? snap.totalPointsBelow : null;

    if (place == null || ours == null) {
      await interaction.reply({ content: 'Rank/points are not available in the latest snapshot.', flags: MessageFlags.Ephemeral });
      return;
    }

    const needForAbove = (above != null && ours != null) ? (above - ours) : null; // positive means needed to overtake
    const leadOverBelow = (below != null && ours != null) ? (ours - below) : null; // positive means we lead

    const lines = [];
    lines.push(`Rank: #${place}`);
    lines.push(`Our points: ${fmt(ours)}`);
    if (above != null) {
      const sign = needForAbove == null ? '' : (needForAbove > 0 ? `need +${fmt(needForAbove)}` : `lead ${fmt(Math.abs(needForAbove))}`);
      lines.push(`Above:     ${fmt(above)} (${sign || '—'})`);
    } else {
      lines.push('Above:     —');
    }
    if (below != null) {
      const sign = leadOverBelow == null ? '' : (leadOverBelow > 0 ? `lead +${fmt(leadOverBelow)}` : `behind ${fmt(Math.abs(leadOverBelow))}`);
      lines.push(`Below:     ${fmt(below)} (${sign || '—'})`);
    } else {
      lines.push('Below:     —');
    }

    const content = '```\n' + lines.join('\n') + '\n```';
    await interaction.reply({ content });
  }
};
