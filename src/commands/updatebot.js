// src/commands/updatebot.js
const { PermissionFlagsBits } = require('discord.js');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

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

      await interaction.deferReply({ ephemeral: false });

      const scriptPath = path.join(process.cwd(), 'update-bot.bat');
      const child = spawn('cmd.exe', ['/c', scriptPath], {
        cwd: process.cwd(),
        windowsHide: true,
        env: { ...process.env },
      });

      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        output += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          if (output.includes('Already up to date.')) { 
            interaction.editReply('```\n' + output + '```\nAlready up to date. No restart needed');
          } else {
            interaction.editReply('```\n' + output + '```\nUpdate successful. Restarting bot...');
            setTimeout(() => {
              const flagPath = path.join(process.cwd(), 'restart.flag');
              fs.writeFileSync(flagPath, new Date().toISOString());
            }, 5000);
          }
        } else {
          interaction.editReply('```\n' + output + '```\nUpdate process exited with code ' + code);
        }
      });

    } catch (e) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('There was an error executing this command.');
        } else {
          await interaction.editReply({ content: 'There was an an error executing this command.', ephemeral: true });
        }
      } catch (_) {}
    }
  }
};