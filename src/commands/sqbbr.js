// src/commands/sqbbr.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getTodaysBr } = require('../brHelper');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sqbbr')
    .setDescription('Reply with the preset SQBBR message from settings.json'),

  async execute(interaction) {
    try {
      // Resolve today's BR via helper shared across features
      const todaysBr = getTodaysBr();

      // Prefer a plaintext file in project root for easy editing
      const txtPath = path.join(process.cwd(), 'sqbbr.txt');
      let raw = null;
      try {
        if (fs.existsSync(txtPath)) {
          raw = fs.readFileSync(txtPath, 'utf8');
        }
      } catch (_) {}
      const text = raw && String(raw).trim().length ? String(raw) : 'SQBBR message is not configured. Create sqbbr.txt in the project root and put your message inside.';
      // Normalize: strip surrounding code fences if present to avoid nesting
      let body = String(text).trim();
      if (body.startsWith('```')) {
        // drop the first fence line (may include language tag)
        const nl = body.indexOf('\n');
        if (nl !== -1) body = body.slice(nl + 1);
        // drop trailing fence if present
        if (body.endsWith('```')) body = body.slice(0, -3);
        // trim residual newlines/whitespace
        body = body.replace(/^\n+|\n+$/g, '').trimEnd();
      }
      const prefixLine = todaysBr ? `Today's BR is ${todaysBr}` : `Today's BR is unknown`;
      // Build a single embed with green border; include header + code-blocked body in description
      const embed = new EmbedBuilder()
        .setTitle(`${prefixLine} `)
        .setDescription(`\u0060\u0060\u0060${body}\n\u0060\u0060\u0060`)
        .setColor(0x57F287);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ embeds: [embed], allowedMentions: { parse: [] } });
      } else {
        await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      }
    } catch (e) {
      try {
        const msg = 'Failed to load sqbbr message.';
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: msg, ephemeral: true });
        } else {
          await interaction.reply({ content: msg, ephemeral: true });
        }
      } catch (_) {}
    }
  }
};
