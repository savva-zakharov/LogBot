// src/commands/sqbbr.js
const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sqbbr')
    .setDescription('Reply with the preset SQBBR message from settings.json'),

  async execute(interaction) {
    try {
      // Prefer a plaintext file in project root for easy editing
      const txtPath = path.join(process.cwd(), 'sqbbr.txt');
      let raw = null;
      try {
        if (fs.existsSync(txtPath)) {
          raw = fs.readFileSync(txtPath, 'utf8');
        }
      } catch (_) {}
      const text = raw && String(raw).trim().length ? String(raw) : 'SQBBR message is not configured. Create sqbbr.txt in the project root and put your message inside.';
      const wrapped = text.trim().startsWith('```') ? text : '```\n' + text + '\n```';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: wrapped, allowedMentions: { parse: [] } });
      } else {
        await interaction.reply({ content: wrapped, allowedMentions: { parse: [] } });
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
