// src/commands/updatebot.js
const { PermissionFlagsBits } = require('discord.js');
const { spawn } = require('child_process');
const path = require('path');

module.exports = {
  data: {
    name: 'updatebot',
    description: 'Runs update-bot.bat to fetch git refs and update npm packages (owner/admin only)'
  },
  async execute(interaction) {
    try {
      // Security: allow only owner if configured, otherwise require Administrator
      const OWNER_ID = process.env.BOT_OWNER_ID || process.env.OWNER_ID || '';

      // If in a guild, we can check admin perms; in DMs this will be undefined
      const isAdmin = interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator);

      if (OWNER_ID) {
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: 'You are not allowed to run this command.', ephemeral: true });
        }
      } else {
        if (!isAdmin) {
          return interaction.reply({ content: 'Administrator permission required to run this command.', ephemeral: true });
        }
      }

      await interaction.deferReply({ ephemeral: true });

      const scriptPath = path.join(process.cwd(), 'update-bot.bat');
      const child = spawn('cmd.exe', ['/c', scriptPath], {
        cwd: process.cwd(),
        windowsHide: true,
        env: { ...process.env },
      });

      let out = '';
      let err = '';

      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });

      const timeoutMs = 60_000;
      const timeout = setTimeout(() => {
        try { child.kill(); } catch (_) {}
      }, timeoutMs);

      child.on('error', async (e) => {
        clearTimeout(timeout);
        try {
          await interaction.editReply(`Failed to start script: ${e.message}`);
        } catch (_) {}
      });

      child.on('close', async (code) => {
        clearTimeout(timeout);
        const max = 1600; // keep under Discord message limits with headroom
        const summary = [
          `Exit code: ${code}`,
          out ? `Output:\n${out.slice(-max)}` : 'No output.',
          err ? `Errors:\n${err.slice(-max)}` : ''
        ].filter(Boolean).join('\n\n');
        try {
          await interaction.editReply(summary);
        } catch (_) {}
      });
    } catch (e) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('There was an error executing this command.');
        } else {
          await interaction.reply({ content: 'There was an error executing this command.', ephemeral: true });
        }
      } catch (_) {}
    }
  }
};
