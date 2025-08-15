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
      // Resolve today's BR from settings.json seasonSchedule
      const settingsPath = path.join(process.cwd(), 'settings.json');
      let todaysBr = null;
      try {
        if (fs.existsSync(settingsPath)) {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
          const sched = settings && settings.seasonSchedule ? settings.seasonSchedule : null;
          if (sched && typeof sched === 'object') {
            const today = new Date();
            const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
            for (const key of Object.keys(sched)) {
              const e = sched[key];
              const sd = e && e.startDate; const ed = e && e.endDate; const br = e && e.br;
              if (sd && ed && br && todayStr >= sd && todayStr <= ed) { todaysBr = br; break; }
            }
          }
        }
      } catch (_) {}

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
      const prefix = todaysBr ? `Today's BR is ${todaysBr}` : `Today's BR is unknown`;
      const content = `${prefix}\n${wrapped}`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, allowedMentions: { parse: [] } });
      } else {
        await interaction.reply({ content, allowedMentions: { parse: [] } });
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
